// ============================================================
// DIRTY Flow Feed.
//
// Hourly scan of DIRTY ERC-20 Transfer events, bucketized by
// counterparty into:
//   • mint           : from = 0x0           (TC rewards + reveal dust)
//   • burn           : to   = 0x0           (Status upgrades, pack burns)
//   • sell_pool      : to   = Kumbaya pool  (DEX sells)
//   • buy_pool       : from = Kumbaya pool  (DEX buys)
//   • sell_router    : to   = TradeRouter   (in-game sellDirty())
//   • buy_router     : from = TradeRouter   (in-game buyDirty())
//   • peer           : everything else      (wallet ↔ wallet)
//
// Persists to `dirty_flow_hourly` keyed by (HKT date, HKT hour).
// Backfills 7 days on startup, then re-scans the last 2 hours
// every 10 minutes (catches in-progress hour + previous boundary).
//
// Drives:
//   • /api/dirty-health  — JSON aggregate for the dashboard tile
//   • DIRTY HEALTH panel on NETWORK tab
//
// Why this matters: the operator is exposed to DIRTY price (their
// earned ops are sold or compounded into INF/Status/packs, all
// DIRTY-denominated). Knowing whether the network is in net buy
// or sell pressure right now informs when to dump or hold.
// ============================================================

import { ethers } from 'ethers';
import { logger } from '../logger';
import type { Storage, DirtyFlowHourlyRow } from '../storage/db';

const RPC = 'https://mainnet.megaeth.com/rpc';
const DIRTY = '0xc2f34f8849a8607fd73e06d6849bda07c2b7de38';
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const KUMBAYA_POOL = '0x6bd9eef21c2419feffafbf4850153a3b3a74a5e1';
const TRADE_ROUTER = '0xf9f676066eb7baeeed93e859bc26a41663f277a8';
const ZERO_ADDR    = '0x0000000000000000000000000000000000000000';

const SECS_PER_BLOCK = 1;
const CHUNK_BLOCKS = 5_000;

// Re-scan cadence — every 10min refreshes the in-progress hour + the
// hour that just closed (catches late-arriving events). 7-day window
// keeps the table from blowing up.
const POLL_MS = 10 * 60_000;
const BACKFILL_DAYS_DEFAULT = 7;

/** Convert UTC ms to HKT (UTC+8) date+hour parts. */
function toHkt(tsMs: number): { date: string; hour: number } {
  const d = new Date(tsMs + 8 * 3600 * 1000);
  return {
    date: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
  };
}

/** Empty bucket factory — keeps key-naming consistent with the SQL row. */
function emptyRow(date: string, hour: number): DirtyFlowHourlyRow {
  return {
    date_hkt: date, hour_hkt: hour,
    mint_dirty: 0,        mint_count: 0,
    burn_dirty: 0,        burn_count: 0,
    sell_pool_dirty: 0,   sell_pool_count: 0,
    buy_pool_dirty: 0,    buy_pool_count: 0,
    sell_router_dirty: 0, sell_router_count: 0,
    buy_router_dirty: 0,  buy_router_count: 0,
    peer_dirty: 0,        peer_count: 0,
    scanned_at: 0,
  };
}

export interface DirtyFlowFeedConfig {
  storage: Storage;
  /** Days to backfill on startup. Default 7. */
  backfillDays?: number;
  /** Re-scan cadence in ms. Default 10min. */
  pollMs?: number;
  /** Override RPC URL for tests. */
  rpcUrl?: string;
}

/**
 * Aggregate snapshot returned by /api/dirty-health. Last-24h + last-7d
 * rollups + per-hour series for the dashboard chart.
 */
export interface DirtyHealthSnapshot {
  generatedAt: number;
  windowDays: number;       // how many days of data we actually have
  hourly: DirtyFlowHourlyRow[];   // chronological, last N hours

  last24h: {
    mints: number; burns: number; netInflation: number;
    sells: number; buys: number; netSell: number;
    burnCapturePct: number | null;   // burns / mints, null if mints=0
  };
  last7d: {
    mints: number; burns: number; netInflation: number;
    sells: number; buys: number; netSell: number;
    burnCapturePct: number | null;
  };
  /** 24h vs 7d-avg deltas (positive = trend rising). null when 7d sample too thin. */
  trend: {
    mints: number | null;          // % change vs 7d daily avg
    burns: number | null;
    netInflation: number | null;
    netSell: number | null;
  };
}

export class DirtyFlowFeed {
  private storage: Storage;
  private provider: ethers.JsonRpcProvider;
  private backfillDays: number;
  private pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;

  constructor(cfg: DirtyFlowFeedConfig) {
    this.storage = cfg.storage;
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl ?? RPC);
    this.backfillDays = cfg.backfillDays ?? BACKFILL_DAYS_DEFAULT;
    this.pollMs = cfg.pollMs ?? POLL_MS;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Backfill is best-effort. If it crashes on first boot the hourly
    // poller still runs and will fill in forward from now.
    try {
      await this.backfillIfNeeded();
    } catch (err: any) {
      logger.warn({ err: err.message }, '[DirtyFlow] backfill failed');
    }
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    if (this.timer.unref) this.timer.unref();
    logger.info('[DirtyFlow] started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  /**
   * Aggregate snapshot for the API + dashboard. Pure function over the
   * persisted hourly rows — cheap to call repeatedly.
   */
  getHealthSnapshot(): DirtyHealthSnapshot {
    const now = Date.now();
    // Pull last 7 days of rows (defensive: the table might have older
    // data lying around from earlier backfills, but we only want the
    // recent window for trend math).
    const sinceMs = now - 7 * 86400_000;
    const rows = this.storage.getDirtyFlowSince(sinceMs);

    const sumWindow = (windowMs: number) => {
      const cutoff = now - windowMs;
      const inWindow = rows.filter(r => this.rowTsMs(r) >= cutoff);
      let mints = 0, burns = 0, sells = 0, buys = 0;
      for (const r of inWindow) {
        mints += r.mint_dirty;
        burns += r.burn_dirty;
        sells += r.sell_pool_dirty + r.sell_router_dirty;
        buys  += r.buy_pool_dirty  + r.buy_router_dirty;
      }
      return {
        mints, burns, netInflation: mints - burns,
        sells, buys, netSell: sells - buys,
        burnCapturePct: mints > 0 ? (burns / mints) * 100 : null,
      };
    };

    const last24h = sumWindow(24 * 3600_000);
    const last7d  = sumWindow(7 * 86400_000);

    // Trend = how does last 24h compare to 7d daily average?
    // Only meaningful when we have ≥3 days of data.
    const distinctDays = new Set(rows.map(r => r.date_hkt)).size;
    const trend = {
      mints:        null as number | null,
      burns:        null as number | null,
      netInflation: null as number | null,
      netSell:      null as number | null,
    };
    if (distinctDays >= 3) {
      const dailyAvg7d = {
        mints: last7d.mints / 7,
        burns: last7d.burns / 7,
        netInflation: last7d.netInflation / 7,
        netSell: last7d.netSell / 7,
      };
      const pctDelta = (cur: number, ref: number) =>
        Math.abs(ref) < 1e-6 ? null : ((cur - ref) / Math.abs(ref)) * 100;
      trend.mints        = pctDelta(last24h.mints,        dailyAvg7d.mints);
      trend.burns        = pctDelta(last24h.burns,        dailyAvg7d.burns);
      trend.netInflation = pctDelta(last24h.netInflation, dailyAvg7d.netInflation);
      trend.netSell      = pctDelta(last24h.netSell,      dailyAvg7d.netSell);
    }

    return {
      generatedAt: now,
      windowDays: distinctDays,
      hourly: rows,
      last24h, last7d, trend,
    };
  }

  // ─── Internals ───────────────────────────────────────────

  /** Re-derive a row's UTC ms from its HKT date+hour. Approximate (hour boundary). */
  private rowTsMs(row: DirtyFlowHourlyRow): number {
    const [y, m, d] = row.date_hkt.split('-').map(Number);
    if (!y || !m || !d) return 0;
    // HKT midnight = UTC 16:00 previous day. So HKT (date, hour) = UTC date 00:00 + (hour - 8) hours.
    return Date.UTC(y, m - 1, d, row.hour_hkt - 8, 0, 0);
  }

  /**
   * Hourly tick — re-scans last 2 hours so the in-progress hour AND the
   * just-closed hour are both updated (events arriving late at the
   * boundary won't be missed).
   */
  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const now = Date.now();
      await this.scanRange(now - 2 * 3600_000, now);
    } catch (err: any) {
      logger.warn({ err: err.message }, '[DirtyFlow] tick failed');
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Backfill: scan whichever of the last `backfillDays` hours we don't
   * already have rows for. Single sweep; cheaper than per-day loops since
   * RPC bandwidth is the bottleneck.
   */
  private async backfillIfNeeded(): Promise<void> {
    const have = this.storage.getDirtyFlowCollectedHours();
    const now = Date.now();
    // Are we missing any of the last 7 days × 24 hours = 168 buckets?
    let missing = 0;
    for (let h = 0; h < this.backfillDays * 24; h++) {
      const tsMs = now - h * 3600_000;
      const { date, hour } = toHkt(tsMs);
      if (!have.has(`${date}|${hour}`)) missing++;
    }
    if (missing === 0) {
      logger.info({ have: have.size }, '[DirtyFlow] backfill not needed');
      return;
    }
    logger.info({ missing, totalBuckets: this.backfillDays * 24 }, '[DirtyFlow] backfilling');
    await this.scanRange(now - this.backfillDays * 86400_000, now);
  }

  /**
   * Scan DIRTY Transfer events in [fromMs, toMs], categorize, and upsert
   * one row per (HKT date, HKT hour). Always upserts even for hours
   * already in the table — the latest scan wins, which lets us repair
   * partial in-progress rows on subsequent ticks.
   */
  private async scanRange(fromMs: number, toMs: number): Promise<void> {
    const latestBlock = await this.provider.getBlock('latest');
    if (!latestBlock) throw new Error('failed to fetch latest block');
    const latestNum = latestBlock.number;
    const latestTsMs = Number(latestBlock.timestamp) * 1000;

    const blocksFromTo   = Math.ceil((latestTsMs - toMs)   / (SECS_PER_BLOCK * 1000));
    const blocksFromFrom = Math.ceil((latestTsMs - fromMs) / (SECS_PER_BLOCK * 1000));
    const startBlock = Math.max(0, latestNum - blocksFromFrom);
    const endBlock = Math.max(startBlock, latestNum - blocksFromTo);

    const buckets: Map<string, DirtyFlowHourlyRow> = new Map();
    const getBucket = (tsMs: number): DirtyFlowHourlyRow => {
      const { date, hour } = toHkt(tsMs);
      const key = `${date}|${hour}`;
      let row = buckets.get(key);
      if (!row) {
        row = emptyRow(date, hour);
        buckets.set(key, row);
      }
      return row;
    };

    let logCount = 0;
    for (let from = startBlock; from <= endBlock; from += CHUNK_BLOCKS) {
      const to = Math.min(from + CHUNK_BLOCKS - 1, endBlock);
      try {
        const logs = await this.provider.getLogs({
          address: DIRTY,
          topics: [TRANSFER_TOPIC],
          fromBlock: from,
          toBlock: to,
        });
        for (const log of logs) {
          const tsMs = latestTsMs - (latestNum - log.blockNumber) * SECS_PER_BLOCK * 1000;
          const fromAddr = ('0x' + log.topics[1].slice(26)).toLowerCase();
          const toAddr   = ('0x' + log.topics[2].slice(26)).toLowerCase();
          const amount   = Number(BigInt(log.data)) / 1e18;
          const row = getBucket(tsMs);

          // Categorize by counterparty. Order matters — pool-from check
          // must fire before peer fallthrough. Mint and burn (0x0) are
          // exclusive endpoints, can't both be true.
          if (fromAddr === ZERO_ADDR) {
            row.mint_dirty += amount; row.mint_count++;
          } else if (toAddr === ZERO_ADDR) {
            row.burn_dirty += amount; row.burn_count++;
          } else if (toAddr === KUMBAYA_POOL) {
            row.sell_pool_dirty += amount; row.sell_pool_count++;
          } else if (fromAddr === KUMBAYA_POOL) {
            row.buy_pool_dirty += amount; row.buy_pool_count++;
          } else if (toAddr === TRADE_ROUTER) {
            row.sell_router_dirty += amount; row.sell_router_count++;
          } else if (fromAddr === TRADE_ROUTER) {
            row.buy_router_dirty += amount; row.buy_router_count++;
          } else {
            row.peer_dirty += amount; row.peer_count++;
          }
          logCount++;
        }
      } catch (err: any) {
        logger.warn({ err: err.message, from, to }, '[DirtyFlow] chunk failed');
      }
    }

    const now = Date.now();
    for (const row of buckets.values()) {
      row.scanned_at = now;
      this.storage.upsertDirtyFlowHourly(row);
    }
    logger.info(
      { hours: buckets.size, events: logCount, blocks: endBlock - startBlock },
      '[DirtyFlow] scan complete',
    );
  }
}
