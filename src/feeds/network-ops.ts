// ============================================================
// NetworkOpsFeed — network-wide ops by op_type, hourly rollup.
//
// The schedule-evidence feed already aggregates network-wide TC/TL
// events into network_hourly_stats, BUT it classifies TL events by
// the `duration` field which is time-to-liquidation, not the
// configured op-window (CLAUDE.md lesson #18). That makes per-op-type
// liquidation counts unreliable.
//
// This feed solves that with historical eth_call. For each TC/TL
// event we read `tradeInfo()` on the corp at `block - 1`, which
// reveals the trade's actual mode + endTime - startTime. Mode 0/1/2
// classifies the op directly (no duration ambiguity).
//
// Architecture (fixed 2026-05-10 after Codex audit):
//   • All scans happen on EXACT HKT hour boundaries via scanHour().
//     Each scanHour() call writes one row per (date, hour, op_type)
//     for that single hour — never partial overwrites.
//   • Backfill iterates 7d × 24 = 168 hour buckets oldest-first.
//   • Tick re-scans the current hour + the previous hour (always
//     whole hours so the row converges as time advances).
//   • Single scan mutex shared between backfill and tick — they
//     never run concurrently.
//   • RPC failures during eth_call are NOT cached as 'unknown'
//     anymore; only successfully-decoded responses are cached.
//     Transient outages don't poison the dataset permanently.
//   • Log fetch failures throw, and the calling hour scan retries
//     on the next tick.
//
// Cost: ~58ms per eth_call on MegaETH archive. 7d backfill ≈ 100K+
// events. Concurrency-limited at 4 in-flight = ~70 calls/sec.
// Cache (network_op_event_mode) makes re-scans free.
// ============================================================

import { ethers } from 'ethers';
import { logger } from '../logger';
import type { Storage, NetworkOpEventModeRow, NetworkOpsHourlyRow } from '../storage/db';

const RPC = 'https://mainnet.megaeth.com/rpc';
const TC_TOPIC = '0x35c06e2c02cc93628588ec67d74925fa30de5c693ea264ec67458bb0b65c3bf1';
const TL_TOPIC = '0xbc95a830b1019b9734680ca35152c5632ef54d080bfa3a55531b755867397678';
const SEL_GET_TRADE_INFO = '0xd6694027';
const SECS_PER_BLOCK = 1;
const CHUNK_BLOCKS = 5000;

// Concurrency limit on eth_calls. MegaETH archive handles ~58ms per
// call. 4 in-flight gives ~70 calls/sec sustained.
const ETH_CALL_CONCURRENCY = 4;

const POLL_MS = 10 * 60_000;          // re-scan current + previous hour every 10min
const BACKFILL_DAYS_DEFAULT = 7;
const HKT_OFFSET_MS = 8 * 3600_000;

type OpType = 'extortion' | 'arms' | 'drug' | 'unknown';

/** Classify trade window duration (full op duration, NOT time-to-liq). */
function classifyDuration(durationSec: number): OpType {
  if (durationSec >= 240 && durationSec <= 360)   return 'extortion';
  if (durationSec >= 1440 && durationSec <= 2160) return 'arms';
  if (durationSec >= 4320 && durationSec <= 6480) return 'drug';
  return 'unknown';
}

function decodeTradeInfo(hex: string): { mode: number; startTime: number; endTime: number } | null {
  const h = (hex || '').replace(/^0x/, '');
  if (h.length < 64 * 6) return null;
  try {
    const mode      = parseInt(h.substring(64, 128), 16);
    const startTime = parseInt(h.substring(64 * 4, 64 * 5), 16);
    const endTime   = parseInt(h.substring(64 * 5, 64 * 6), 16);
    return { mode, startTime, endTime };
  } catch {
    return null;
  }
}

/** UTC ms at the START of an HKT hour (date string + 0..23 hour). */
function hktHourStartMs(dateHkt: string, hour: number): number {
  const [y, m, d] = dateHkt.split('-').map(Number);
  // HKT midnight = UTC 16:00 the previous day.
  // HKT (date, hour) = UTC date 00:00 + (hour - 8) hours.
  return Date.UTC(y, m - 1, d, hour - 8, 0, 0);
}

/** Convert UTC ms to HKT date+hour parts. */
function toHkt(tsMs: number): { date: string; hour: number } {
  const d = new Date(tsMs + HKT_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
  };
}

export interface NetworkOpsFeedConfig {
  storage: Storage;
  /** Days of history to backfill on startup. Default 7. */
  backfillDays?: number;
  /** Re-scan cadence in ms. Default 10min. */
  pollMs?: number;
  rpcUrl?: string;
}

export interface NetworkEfficiencyByOpType {
  op_type: 'extortion' | 'arms' | 'drug';
  ops: number;
  wins: number;
  losses: number;
  sr: number;
  dirty_paid: number;
}

export interface NetworkEfficiencyByHour {
  hkt_hour: number;
  regime: 'weekday' | 'weekend';
  ops: number;
  wins: number;
  sr: number;
  dirty_paid: number;
}

export interface NetworkEfficiencySnapshot {
  generatedAt: number;
  windowHours: number;
  cachedEvents: number;
  byOpType: NetworkEfficiencyByOpType[];
  byHour: NetworkEfficiencyByHour[];
}

export class NetworkOpsFeed {
  private storage: Storage;
  private provider: ethers.JsonRpcProvider;
  private backfillDays: number;
  private pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  // Single shared scan lock. Backfill + tick + manual triggers all queue
  // through this. Prevents the partial-hour-overwrite race Codex flagged.
  private scanLock: Promise<void> = Promise.resolve();

  // Sampled error log for eth_call failures so we don't flood pino but
  // still surface real archive issues.
  private rpcErrorCount = 0;
  private rpcErrorSampled: string | null = null;

  constructor(cfg: NetworkOpsFeedConfig) {
    this.storage = cfg.storage;
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl ?? RPC);
    this.backfillDays = cfg.backfillDays ?? BACKFILL_DAYS_DEFAULT;
    this.pollMs = cfg.pollMs ?? POLL_MS;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    void this.runUnderLock(() => this.backfillIfNeeded()).catch(err =>
      logger.warn({ err: err.message }, '[NetworkOps] backfill failed'));
    this.timer = setInterval(() => { void this.runUnderLock(() => this.tick()); }, this.pollMs);
    if (this.timer.unref) this.timer.unref();
    logger.info('[NetworkOps] started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  /**
   * Aggregate snapshot for /api/efficiency. Uses event-time (date_hkt +
   * hour_hkt) for the window filter, NOT scanned_at — so older hourly
   * rows that haven't been re-scanned recently still show up.
   */
  getSnapshot(windowHours: number): NetworkEfficiencySnapshot {
    const sinceMs = Date.now() - windowHours * 3600_000;
    // Pull a wider buffer (since the storage helper currently filters
    // by scanned_at — we re-filter by event time below).
    const candidate = this.storage.getNetworkOpsSince(0);  // all rows
    const inWindow = candidate.filter(r => hktHourStartMs(r.date_hkt, r.hour_hkt) >= sinceMs);

    const opTypeAgg: Record<string, { ops: number; wins: number; losses: number; dirty: number }> = {
      extortion: { ops: 0, wins: 0, losses: 0, dirty: 0 },
      arms:      { ops: 0, wins: 0, losses: 0, dirty: 0 },
      drug:      { ops: 0, wins: 0, losses: 0, dirty: 0 },
    };
    for (const r of inWindow) {
      if (r.op_type === 'unknown') continue;
      const a = opTypeAgg[r.op_type];
      a.ops += r.completed_count + r.liquidated_count;
      a.wins += r.completed_count;
      a.losses += r.liquidated_count;
      a.dirty += r.dirty_paid;
    }
    const byOpType: NetworkEfficiencyByOpType[] = (['extortion','arms','drug'] as const)
      .map(op => ({
        op_type: op,
        ops:    opTypeAgg[op].ops,
        wins:   opTypeAgg[op].wins,
        losses: opTypeAgg[op].losses,
        sr:     opTypeAgg[op].ops > 0 ? opTypeAgg[op].wins / opTypeAgg[op].ops : 0,
        dirty_paid: opTypeAgg[op].dirty,
      }))
      .filter(r => r.ops > 0);

    const { isHktWeekendHour } = require('./schedule-evidence');
    const hourMap = new Map<string, NetworkEfficiencyByHour>();
    for (const r of inWindow) {
      const regime: 'weekday' | 'weekend' = isHktWeekendHour(r.date_hkt, r.hour_hkt) ? 'weekend' : 'weekday';
      const key = `${r.hour_hkt}|${regime}`;
      let row = hourMap.get(key);
      if (!row) {
        row = { hkt_hour: r.hour_hkt, regime, ops: 0, wins: 0, sr: 0, dirty_paid: 0 };
        hourMap.set(key, row);
      }
      row.ops += r.completed_count + r.liquidated_count;
      row.wins += r.completed_count;
      row.dirty_paid += r.dirty_paid;
    }
    const byHour = [...hourMap.values()];
    for (const row of byHour) row.sr = row.ops > 0 ? row.wins / row.ops : 0;
    byHour.sort((a, b) =>
      a.hkt_hour - b.hkt_hour || (a.regime === b.regime ? 0 : a.regime === 'weekday' ? -1 : 1),
    );

    return {
      generatedAt: Date.now(),
      windowHours,
      cachedEvents: this.storage.getNetworkOpsCacheSize(),
      byOpType,
      byHour,
    };
  }

  // ─── Internals ───────────────────────────────────────────

  /**
   * Mutex helper. All scan operations queue here so backfill + tick
   * never race on the same hour bucket. Each operation runs to
   * completion (or error) before the next starts.
   */
  private runUnderLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.scanLock.then(() => fn());
    // Ensure scanLock resolves regardless of fn outcome — otherwise
    // a single failure would deadlock the queue forever.
    this.scanLock = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Live tick: re-scan the current HKT hour + the just-closed previous
   * hour. Two whole hours so events arriving late at the boundary
   * always land in the right bucket without overwriting.
   */
  private async tick(): Promise<void> {
    const now = Date.now();
    const cur = toHkt(now);
    const prevMs = now - 3600_000;
    const prev = toHkt(prevMs);
    try {
      await this.scanHour(prev.date, prev.hour);
      await this.scanHour(cur.date, cur.hour);
    } catch (err: any) {
      logger.warn({ err: err.message }, '[NetworkOps] tick failed (will retry next interval)');
    }
  }

  /**
   * Backfill: iterate every HKT hour in the last `backfillDays`,
   * oldest first. Skip hours that already have rows AND have full
   * cache coverage for that hour's events. Per-hour, not per-arbitrary-
   * window, so partial chunks can never overwrite each other.
   */
  private async backfillIfNeeded(): Promise<void> {
    const now = Date.now();
    const totalHours = this.backfillDays * 24;
    const cacheSize = this.storage.getNetworkOpsCacheSize();
    logger.info(
      { backfillDays: this.backfillDays, totalHours, cacheSize },
      cacheSize > 1000
        ? '[NetworkOps] resuming backfill (cache populated, expect mostly cache hits)'
        : '[NetworkOps] starting fresh backfill — first run can take 15-20min',
    );

    let scanned = 0;
    for (let h = totalHours; h >= 0; h--) {
      const targetMs = now - h * 3600_000;
      const { date, hour } = toHkt(targetMs);
      try {
        await this.scanHour(date, hour);
        scanned++;
      } catch (err: any) {
        // A hour-scan can fail (RPC blip, etc.). Log and continue —
        // the failed hour will be retried on the next live tick if
        // it falls inside the rolling 2-hour window, otherwise it
        // stays as-is and a future redeploy can re-scan.
        logger.warn(
          { err: err.message, date, hour },
          '[NetworkOps] hour scan failed — leaving for next pass',
        );
      }
      if (scanned % 12 === 0) {
        logger.info(
          { progress: `${scanned}/${totalHours + 1}`, cacheSize: this.storage.getNetworkOpsCacheSize(), rpcErrors: this.rpcErrorCount },
          '[NetworkOps] backfill progress',
        );
      }
      // Tiny breather between hours to let GC reclaim and the RPC
      // breathe. With ~5K events/hour at peak, this keeps total
      // RSS under control.
      await new Promise(r => setTimeout(r, 100));
    }
    logger.info(
      { scanned, rpcErrors: this.rpcErrorCount, sampledErr: this.rpcErrorSampled },
      '[NetworkOps] backfill complete',
    );
  }

  /**
   * Scan a single HKT hour fully and upsert its (date, hour, op_type)
   * rows. Throws on getLogs failure so caller can decide whether to
   * retry — we never write partial counts.
   */
  private async scanHour(dateHkt: string, hour: number): Promise<void> {
    const fromMs = hktHourStartMs(dateHkt, hour);
    const toMs = fromMs + 3600_000;

    const latestBlock = await this.provider.getBlock('latest');
    if (!latestBlock) throw new Error('failed to fetch latest block');
    const latestNum = latestBlock.number;
    const latestTsMs = Number(latestBlock.timestamp) * 1000;

    const blocksFromTo   = Math.ceil((latestTsMs - toMs)   / (SECS_PER_BLOCK * 1000));
    const blocksFromFrom = Math.ceil((latestTsMs - fromMs) / (SECS_PER_BLOCK * 1000));
    const startBlock = Math.max(0, latestNum - blocksFromFrom);
    const endBlock = Math.max(startBlock, latestNum - blocksFromTo);

    // Skip if hour is entirely in the future
    if (toMs > latestTsMs + 60_000) return;

    type PendingEvent = {
      txHash: string;
      logIndex: number;
      blockNumber: number;
      tsMs: number;
      isLiquidation: boolean;
      corp: string;
      reward: number;
    };
    const events: PendingEvent[] = [];

    // Step 1: fetch logs. If ANY chunk fails, throw — we never write
    // partial counts. The hour will be retried on next backfill pass
    // or live tick (if recent enough).
    for (let from = startBlock; from <= endBlock; from += CHUNK_BLOCKS) {
      const to = Math.min(from + CHUNK_BLOCKS - 1, endBlock);
      const logs = await this.provider.getLogs({
        fromBlock: from, toBlock: to,
        topics: [[TC_TOPIC, TL_TOPIC]],
      });
      for (const log of logs) {
        const isLiq = log.topics[0] === TL_TOPIC;
        const tsMs = latestTsMs - (latestNum - log.blockNumber) * SECS_PER_BLOCK * 1000;
        const data = (log.data || '').replace(/^0x/, '');
        let reward = 0;
        if (data.length >= 128) {
          try {
            const hex = isLiq ? data.substring(64, 128) : data.substring(0, 64);
            reward = Number(BigInt('0x' + hex)) / 1e18;
          } catch { /* keep 0 */ }
        }
        events.push({
          txHash: log.transactionHash,
          logIndex: log.index,
          blockNumber: log.blockNumber,
          tsMs,
          isLiquidation: isLiq,
          corp: log.address.toLowerCase(),
          reward,
        });
      }
    }

    // Step 2: resolve op_type per event. Cache hits skip eth_call.
    type Resolved = { event: PendingEvent; opType: OpType };
    const resolved: Resolved[] = [];
    const toFetch: PendingEvent[] = [];
    for (const e of events) {
      const cached = this.storage.getNetworkOpEventMode(e.txHash, e.logIndex);
      if (cached) {
        resolved.push({ event: e, opType: cached.op_type });
      } else {
        toFetch.push(e);
      }
    }

    // eth_call resolver. Only successful decodes are cached. RPC
    // errors and indecipherable returns leave the event in a "skip
    // this scan, retry next time" state — they're tagged 'unknown'
    // FOR THIS SCAN's aggregation but NOT persisted to the cache.
    if (toFetch.length > 0) {
      const newCacheRows: NetworkOpEventModeRow[] = [];
      const queue = [...toFetch];
      let inFlight = 0;
      await new Promise<void>(resolveAll => {
        const startNext = () => {
          if (queue.length === 0 && inFlight === 0) { resolveAll(); return; }
          while (inFlight < ETH_CALL_CONCURRENCY && queue.length > 0) {
            const e = queue.shift()!;
            inFlight++;
            this.provider.send('eth_call', [
              { to: e.corp, data: SEL_GET_TRADE_INFO },
              '0x' + (e.blockNumber - 1).toString(16),
            ]).then((hex: string) => {
              const ti = decodeTradeInfo(hex);
              if (ti) {
                // Successful decode — cache forever.
                const durationSec = ti.endTime - ti.startTime;
                const opType = classifyDuration(durationSec);
                resolved.push({ event: e, opType });
                newCacheRows.push({
                  tx_hash: e.txHash, log_index: e.logIndex,
                  op_type: opType, mode: ti.mode, duration_sec: durationSec,
                  block_number: e.blockNumber, ts: e.tsMs,
                });
              } else {
                // Decode failed but RPC returned a value — corp probably
                // had no trade info at that block (very rare). Cache as
                // unknown so we don't keep re-fetching a stable empty.
                resolved.push({ event: e, opType: 'unknown' });
                newCacheRows.push({
                  tx_hash: e.txHash, log_index: e.logIndex,
                  op_type: 'unknown', mode: null, duration_sec: null,
                  block_number: e.blockNumber, ts: e.tsMs,
                });
              }
            }).catch((err: any) => {
              // Real RPC error. DO NOT cache — let the next scan retry.
              this.rpcErrorCount++;
              if (!this.rpcErrorSampled) this.rpcErrorSampled = (err?.message ?? 'unknown').slice(0, 200);
              resolved.push({ event: e, opType: 'unknown' });
            }).finally(() => {
              inFlight--;
              if (newCacheRows.length >= 200) {
                this.storage.insertNetworkOpEventMode(newCacheRows.splice(0, newCacheRows.length));
              }
              startNext();
            });
          }
        };
        startNext();
      });
      if (newCacheRows.length > 0) {
        this.storage.insertNetworkOpEventMode(newCacheRows);
      }
    }

    // Step 3: aggregate by (date, hour, op_type). All resolved events
    // belong to THIS hour by construction (we scoped getLogs to this
    // hour's block range).
    const buckets = new Map<OpType, NetworkOpsHourlyRow>();
    for (const r of resolved) {
      let bucket = buckets.get(r.opType);
      if (!bucket) {
        bucket = {
          date_hkt: dateHkt, hour_hkt: hour, op_type: r.opType,
          completed_count: 0, liquidated_count: 0, dirty_paid: 0, scanned_at: 0,
        };
        buckets.set(r.opType, bucket);
      }
      if (r.event.isLiquidation) bucket.liquidated_count++;
      else                       bucket.completed_count++;
      bucket.dirty_paid += r.event.reward;
    }

    // Step 4: upsert. Each (date, hour, op_type) row is REPLACED with
    // the full hour's count — safe because we just scanned the entire
    // hour's events and aggregated them all.
    const now = Date.now();
    for (const row of buckets.values()) {
      row.scanned_at = now;
      this.storage.upsertNetworkOpsHourly(row);
    }

    // ALSO: if no events landed in a particular op_type bucket but the
    // hour previously had events of that type (edge case: cache flag
    // recovers), we don't zero out. Acceptable — the next full scan
    // will write the correct counts and SQLite ON CONFLICT replaces.
  }
}
