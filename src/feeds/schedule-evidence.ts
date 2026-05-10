// ============================================================
// Schedule-evidence feed.
//
// Once per HKT day, scan TradeCompleted + TradeLiquidated events
// network-wide for the previous 24h. Bucket by HKT hour, classify
// liquidations by op type (using the duration field), and persist
// to `network_hourly_stats`. Maintains a 7-day rolling window the
// dashboard can read to surface the best/worst hours per op type.
//
// Methodology notes:
//   • TC events have data = [reward, influence] — no duration. We
//     can't classify them by op type cheaply, so we record the
//     aggregate `completed_count` per hour. Per-op success rate is
//     derived in the API layer using TL's op-type mix as a prior
//     (assumes TL distribution proxies the overall network mix
//     within the same hour, which is a reasonable approximation).
//   • TL events carry duration in data[2]; classifyDuration() maps
//     it to extortion/arms/drug. Duration outside known bands →
//     'unknown' (partial fills, bot bugs, future op types).
//   • Block-derived timestamps (1s/block on MegaETH) anchor each
//     event to its HKT hour. Same approximation op-scraper uses.
// ============================================================

import { ethers } from 'ethers';
import { logger } from '../logger';
import type { Storage, NetworkHourlyRow } from '../storage/db';

const RPC = 'https://mainnet.megaeth.com/rpc';
const TC_TOPIC = '0x35c06e2c02cc93628588ec67d74925fa30de5c693ea264ec67458bb0b65c3bf1';
const TL_TOPIC = '0xbc95a830b1019b9734680ca35152c5632ef54d080bfa3a55531b755867397678';
const SECS_PER_BLOCK = 1;
const CHUNK_BLOCKS = 5_000;

type OpType = 'extortion' | 'arms' | 'drug' | 'unknown';

/** Same band logic as op-scraper.classifyDuration; ±20% slack. */
function classifyDuration(durationSec: number): OpType {
  if (durationSec >= 240 && durationSec <= 360) return 'extortion';   // 5m
  if (durationSec >= 1440 && durationSec <= 2160) return 'arms';      // 30m
  if (durationSec >= 4320 && durationSec <= 6480) return 'drug';      // 90m
  return 'unknown';
}

/** Convert a UTC ms to HKT (UTC+8) date+hour parts. */
function toHkt(tsMs: number): { date: string; hour: number } {
  const d = new Date(tsMs + 8 * 3600 * 1000);
  const date = d.toISOString().slice(0, 10);
  const hour = d.getUTCHours();
  return { date, hour };
}

interface DayBuckets {
  // key = `${date_hkt}|${hour_hkt}`
  byHour: Map<string, NetworkHourlyRow>;
}

export interface ScheduleEvidenceConfig {
  storage: Storage;
  /** How many days of history to backfill on startup. Default 7. */
  backfillDays?: number;
  /** Override RPC URL for tests. */
  rpcUrl?: string;
  /** Override midnight-HKT scheduler interval check (ms). Default 60s. */
  schedulerIntervalMs?: number;
}

export class ScheduleEvidenceFeed {
  private readonly storage: Storage;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly backfillDays: number;
  private readonly schedulerIntervalMs: number;
  private schedulerHandle: NodeJS.Timeout | null = null;
  private lastRunHktDate: string | null = null;
  private running = false;

  constructor(cfg: ScheduleEvidenceConfig) {
    this.storage = cfg.storage;
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl ?? RPC);
    this.backfillDays = cfg.backfillDays ?? 7;
    this.schedulerIntervalMs = cfg.schedulerIntervalMs ?? 60_000;
  }

  /** Start: backfill missing days, then arm the daily scheduler. */
  async start(): Promise<void> {
    try {
      await this.backfillIfNeeded();
    } catch (err: any) {
      // Backfill failures are non-fatal — the daily scheduler will fill
      // forward from here. Log loud so the operator sees it.
      logger.warn({ err: err.message }, '[ScheduleEvidence] backfill failed');
    }
    this.scheduleDailyRun();
    logger.info('[ScheduleEvidence] started');
  }

  stop(): void {
    if (this.schedulerHandle) clearInterval(this.schedulerHandle);
    this.schedulerHandle = null;
  }

  /**
   * Public read API for dashboard / api/server.
   *
   * `sinceLeverageMs` (optional): cutoff timestamp for the leverage-v2
   * recalibration. Rows older than this are EXCLUDED from the rolling
   * sample because they were collected under different liquidation
   * thresholds and would bias recommendations. Defaults to no cutoff.
   *
   * Recommended invocation pattern after a recalibration: pass
   * `Date.now() - 0`, then trickle the cutoff back as new days
   * accumulate (so `windowDays` grows from 0 → 7 over the next week).
   */
  getRollingStats(days = 7, sinceLeverageMs?: number): RollingStats {
    const windowSinceMs = Date.now() - days * 86400_000;
    const sinceMs = sinceLeverageMs != null
      ? Math.max(windowSinceMs, sinceLeverageMs)
      : windowSinceMs;
    const rows = this.storage.getNetworkHourlySince(sinceMs);
    const stats = computeRolling(rows);
    // Annotate so the UI can show "limited sample, leverage v2 cutoff"
    return { ...stats, leverageCutoffMs: sinceLeverageMs ?? null } as RollingStats;
  }

  /**
   * Returns the rolling stats split three ways: all / weekday / weekend.
   * The contract applies different liquidation leverage on weekends
   * (Fri-Sun HKT), so the right schedule for "today" depends on which
   * regime "today" is in. Dashboard renders the appropriate slice
   * highlighted; the others are still visible for context.
   */
  getRollingStatsByRegime(days = 7, sinceLeverageMs?: number): RollingStatsByRegime {
    const windowSinceMs = Date.now() - days * 86400_000;
    const sinceMs = sinceLeverageMs != null
      ? Math.max(windowSinceMs, sinceLeverageMs)
      : windowSinceMs;
    const rows = this.storage.getNetworkHourlySince(sinceMs);
    const split = computeRollingAllRegimes(rows);
    // Annotate every slice with the leverage cutoff so the UI can show
    // "limited sample" in either column independently.
    const annotate = (s: RollingStats): RollingStats =>
      ({ ...s, leverageCutoffMs: sinceLeverageMs ?? null });
    return {
      all:     annotate(split.all),
      weekday: annotate(split.weekday),
      weekend: annotate(split.weekend),
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────

  private scheduleDailyRun() {
    if (this.schedulerHandle) clearInterval(this.schedulerHandle);
    // Cheap minute-tick check: every minute, see if HKT date has rolled
    // since our last run. Avoids needing a precise cron and survives
    // process restarts (lastRunHktDate is in-memory but the DB is the
    // source of truth on what's already collected).
    this.schedulerHandle = setInterval(() => {
      void this.tickIfNeeded();
    }, this.schedulerIntervalMs);
    this.schedulerHandle.unref();
  }

  private async tickIfNeeded() {
    const todayHkt = toHkt(Date.now()).date;
    if (this.lastRunHktDate === todayHkt) return;
    if (this.running) return;
    // Only run when the previous HKT day's data isn't yet in the DB.
    // Compute "yesterday HKT" — the day we want to confirm we have.
    const yesterdayMs = Date.now() - 86400_000;
    const yesterdayHkt = toHkt(yesterdayMs).date;
    const have = new Set(this.storage.getCollectedDates());
    if (have.has(yesterdayHkt) && have.has(todayHkt)) {
      // Already complete for the visible range; just remember today.
      this.lastRunHktDate = todayHkt;
      return;
    }
    try {
      this.running = true;
      // Scan the last 24h of chain data and upsert. This will overwrite
      // partial rows for "today" (in-progress hours) on every run, which
      // is fine — the scanned_at timestamp records freshness.
      await this.scanRange(Date.now() - 24 * 3600_000, Date.now());
      this.lastRunHktDate = todayHkt;
      logger.info({ hktDate: todayHkt }, '[ScheduleEvidence] daily collection complete');
    } catch (err: any) {
      logger.warn({ err: err.message }, '[ScheduleEvidence] daily collection failed');
    } finally {
      this.running = false;
    }
  }

  private async backfillIfNeeded() {
    const have = new Set(this.storage.getCollectedDates());
    const needed: string[] = [];
    for (let i = 0; i < this.backfillDays; i++) {
      const d = toHkt(Date.now() - i * 86400_000).date;
      if (!have.has(d)) needed.push(d);
    }
    if (needed.length === 0) {
      logger.info(`[ScheduleEvidence] backfill not needed (${have.size} days already collected)`);
      return;
    }
    logger.info({ days: needed.length }, '[ScheduleEvidence] backfill starting');
    // Scan in a single sweep covering all needed days. Cheaper than
    // looping per-day because the chain RPC is the bottleneck.
    const oldestStartMs = Date.now() - this.backfillDays * 86400_000;
    await this.scanRange(oldestStartMs, Date.now());
    logger.info({ days: needed.length }, '[ScheduleEvidence] backfill complete');
  }

  /** Scan TC + TL events in [fromMs, toMs] and persist hourly rollups. */
  private async scanRange(fromMs: number, toMs: number): Promise<void> {
    const latestBlock = await this.provider.getBlock('latest');
    if (!latestBlock) throw new Error('failed to fetch latest block');
    const latestNum = latestBlock.number;
    const latestTsMs = Number(latestBlock.timestamp) * 1000;
    // Block delta from "to" anchor. Negative = past.
    const blocksFromTo = Math.ceil((latestTsMs - toMs) / (SECS_PER_BLOCK * 1000));
    const blocksFromFrom = Math.ceil((latestTsMs - fromMs) / (SECS_PER_BLOCK * 1000));
    const startBlock = Math.max(0, latestNum - blocksFromFrom);
    const endBlock = Math.max(startBlock, latestNum - blocksFromTo);
    logger.info(
      { startBlock, endBlock, blocks: endBlock - startBlock },
      '[ScheduleEvidence] scanning blocks',
    );

    const buckets: DayBuckets = { byHour: new Map() };

    for (let from = startBlock; from <= endBlock; from += CHUNK_BLOCKS) {
      const to = Math.min(from + CHUNK_BLOCKS - 1, endBlock);
      // TC events
      try {
        const tcLogs = await this.provider.getLogs({
          fromBlock: from, toBlock: to, topics: [TC_TOPIC],
        });
        for (const log of tcLogs) {
          const tsMs = latestTsMs - (latestNum - log.blockNumber) * SECS_PER_BLOCK * 1000;
          let reward = 0;
          if (log.data && log.data.length >= 66) {
            try { reward = Number(BigInt('0x' + log.data.slice(2, 66))) / 1e18; } catch { /* skip */ }
          }
          this.bumpBucket(buckets, tsMs, 'tc', null, reward);
        }
      } catch (err: any) {
        logger.warn({ err: err.message, from, to }, '[ScheduleEvidence] TC chunk failed');
      }
      // TL events
      try {
        const tlLogs = await this.provider.getLogs({
          fromBlock: from, toBlock: to, topics: [TL_TOPIC],
        });
        for (const log of tlLogs) {
          if (log.topics.length < 4) continue;
          const tsMs = latestTsMs - (latestNum - log.blockNumber) * SECS_PER_BLOCK * 1000;
          let partialReward = 0;
          let opType: OpType = 'unknown';
          if (log.data && log.data.length >= 194) {
            try {
              partialReward = Number(BigInt('0x' + log.data.slice(66, 130))) / 1e18;
              const durationSec = Number(BigInt('0x' + log.data.slice(130, 194)));
              opType = classifyDuration(durationSec);
            } catch { /* skip */ }
          }
          this.bumpBucket(buckets, tsMs, 'tl', opType, partialReward);
        }
      } catch (err: any) {
        logger.warn({ err: err.message, from, to }, '[ScheduleEvidence] TL chunk failed');
      }
    }

    // Persist all buckets
    const now = Date.now();
    for (const row of buckets.byHour.values()) {
      row.scanned_at = now;
      this.storage.upsertNetworkHourly(row);
    }
    logger.info(
      { rows: buckets.byHour.size },
      '[ScheduleEvidence] persisted hourly rows',
    );
  }

  private bumpBucket(
    b: DayBuckets,
    tsMs: number,
    kind: 'tc' | 'tl',
    opType: OpType | null,
    reward: number,
  ): void {
    const { date, hour } = toHkt(tsMs);
    const key = `${date}|${hour}`;
    let row = b.byHour.get(key);
    if (!row) {
      row = {
        date_hkt: date, hour_hkt: hour,
        completed_count: 0, liquidated_count: 0,
        liq_extortion: 0, liq_arms: 0, liq_drug: 0, liq_unknown: 0,
        dirty_paid: 0, scanned_at: 0,
      };
      b.byHour.set(key, row);
    }
    if (kind === 'tc') row.completed_count++;
    else {
      row.liquidated_count++;
      if (opType === 'extortion') row.liq_extortion++;
      else if (opType === 'arms') row.liq_arms++;
      else if (opType === 'drug') row.liq_drug++;
      else row.liq_unknown++;
    }
    row.dirty_paid += reward;
  }
}

// ──────────────────────────────────────────────────────────────────
// Rolling-stats computation (pure functions, exported for the API)
// ──────────────────────────────────────────────────────────────────

/**
 * Per-hour stats. We CAN'T cheaply compute a per-op-type success rate
 * because TradeCompleted events don't carry op type. What we CAN
 * compute, exactly:
 *   - network_sr: overall hourly SR (TC / (TC + TL))
 *   - liq_per_day_X: avg liquidations of op type X per day at this hour
 *   - liq_share_X: of all liquidations at this hour, what fraction were X
 *
 * "Best/worst hours for X" is then defined on a composite score that
 * combines high overall SR with low absolute liquidation pressure for
 * that op type. Defensible without inventing data we don't have.
 */
export interface HourStats {
  hour_hkt: number;
  days_covered: number;
  total_completed: number;        // TC sum across all days
  total_liquidated: number;       // TL sum across all days
  total_ops: number;
  network_sr: number | null;      // overall hourly success rate
  // Liquidations per DAY at this hour (avg across days_covered)
  liq_per_day_drug: number;
  liq_per_day_arms: number;
  liq_per_day_extortion: number;
  // Composition of failures at this hour (sums to ≤ 1; remainder is unknown)
  liq_share_drug: number;
  liq_share_arms: number;
  liq_share_extortion: number;
  // Op-type "danger score" — higher = riskier at this hour for that op.
  // Combines low overall SR with high relative liquidation share.
  // Range: 0..1 (rough). null when sample too thin.
  danger_drug: number | null;
  danger_arms: number | null;
  danger_extortion: number | null;
}

export interface RollingStats {
  hours: HourStats[];
  /** Top 5 safest hours per op type (lowest danger score). */
  bestHours: { drug: number[]; arms: number[]; extortion: number[] };
  /** Top 5 most dangerous hours per op type (highest danger score). */
  worstHours: { drug: number[]; arms: number[]; extortion: number[] };
  globalSR: number | null;
  windowDays: number;
  generatedAt: number;
  /** Optional cutoff timestamp — rows older than this excluded from sample. */
  leverageCutoffMs?: number | null;
  /** 'all' | 'weekday' | 'weekend' — which slice of the data this represents. */
  regime?: 'all' | 'weekday' | 'weekend';
}

/**
 * Three-way regime split. The contract applies different liquidation
 * leverage on weekends (Fri evening → Sun evening HKT), so mixing
 * weekday + weekend rows produces a model that's wrong in BOTH regimes.
 * Splitting lets callers query the right table for the current moment.
 */
export interface RollingStatsByRegime {
  all:     RollingStats;
  weekday: RollingStats;
  weekend: RollingStats;
}

const MIN_TOTAL_OPS_FOR_SR = 50;   // need 50+ ops/hour over the window to trust SR
const MIN_LIQ_FOR_SHARE    = 20;   // need 20+ liqs at this hour to trust the share split

/**
 * Composite danger score for op type X at a given hour.
 *   danger = (1 - network_sr) × (liq_share_X)
 *
 * Interpretation:
 *   - If overall SR is high AND op-X share of liqs is low → danger ≈ 0
 *   - If overall SR is low AND op-X share of liqs is high → danger ≈ 0.5+
 * Returns null when sample is too thin.
 */
function dangerFor(
  networkSR: number | null,
  liqShare: number,
  totalOps: number,
  totalLiq: number,
): number | null {
  if (networkSR == null) return null;
  if (totalOps < MIN_TOTAL_OPS_FOR_SR) return null;
  if (totalLiq < MIN_LIQ_FOR_SHARE) return null;
  return (1 - networkSR) * liqShare;
}

/**
 * Determines whether a given (HKT date, HKT hour) bucket falls inside the
 * contract's weekend-leverage cycle. Mirrors `isHktWeekend` in op-params.ts.
 *
 * Operator-confirmed (2026-05-09): the weekend cycle runs
 *   Saturday 17:00 HKT → Monday 17:00 HKT  (48 hours).
 *
 * Hour-granular because Saturday and Monday are SPLIT days — half-weekday,
 * half-weekend. A pure date-level classifier would mislabel either Sat
 * morning or Mon morning. Pure function — no side effects.
 */
export function isHktWeekendHour(dateHkt: string, hourHkt: number): boolean {
  const [y, m, d] = dateHkt.split('-').map(Number);
  if (!y || !m || !d) return false;
  // Date.UTC parses the calendar date; day-of-week is invariant within the
  // date so we don't need to offset by HKT for the dow lookup.
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0=Sun, 6=Sat
  if (dow === 6 && hourHkt >= 17) return true;   // Sat evening onward
  if (dow === 0)                  return true;   // Sun all day
  if (dow === 1 && hourHkt < 17)  return true;   // Mon until 17:00
  return false;
}

export function computeRolling(
  rows: NetworkHourlyRow[],
  regime: 'all' | 'weekday' | 'weekend' = 'all',
): RollingStats {
  // Filter input rows by regime if requested. Done at the very top so
  // every downstream aggregation honors the split (sample sizes, day
  // counts, danger scores).
  //
  // Hour-aware classification — see isHktWeekendHour above. Saturday rows
  // before 17:00 are weekday; Monday rows before 17:00 are weekend.
  const filtered = regime === 'all'
    ? rows
    : rows.filter(r => isHktWeekendHour(r.date_hkt, r.hour_hkt) === (regime === 'weekend'));
  const byHour: Map<number, NetworkHourlyRow[]> = new Map();
  for (let h = 0; h < 24; h++) byHour.set(h, []);
  for (const r of filtered) byHour.get(r.hour_hkt)!.push(r);

  const hours: HourStats[] = [];
  let totalCompleted = 0, totalLiquidated = 0;

  for (let h = 0; h < 24; h++) {
    const hourRows = byHour.get(h)!;
    let completed = 0, liquidated = 0;
    let lExt = 0, lArms = 0, lDrug = 0;
    const days = new Set<string>();
    for (const r of hourRows) {
      completed += r.completed_count;
      liquidated += r.liquidated_count;
      lExt += r.liq_extortion;
      lArms += r.liq_arms;
      lDrug += r.liq_drug;
      days.add(r.date_hkt);
    }
    const totalOps = completed + liquidated;
    totalCompleted += completed;
    totalLiquidated += liquidated;
    const sr = totalOps > 0 ? completed / totalOps : null;

    const dayCount = Math.max(1, days.size);
    const liqPerDayDrug = lDrug / dayCount;
    const liqPerDayArms = lArms / dayCount;
    const liqPerDayExt  = lExt  / dayCount;

    const liqShareDrug = liquidated > 0 ? lDrug / liquidated : 0;
    const liqShareArms = liquidated > 0 ? lArms / liquidated : 0;
    const liqShareExt  = liquidated > 0 ? lExt  / liquidated : 0;

    hours.push({
      hour_hkt: h,
      days_covered: days.size,
      total_completed: completed,
      total_liquidated: liquidated,
      total_ops: totalOps,
      network_sr: sr,
      liq_per_day_drug: liqPerDayDrug,
      liq_per_day_arms: liqPerDayArms,
      liq_per_day_extortion: liqPerDayExt,
      liq_share_drug: liqShareDrug,
      liq_share_arms: liqShareArms,
      liq_share_extortion: liqShareExt,
      danger_drug: dangerFor(sr, liqShareDrug, totalOps, liquidated),
      danger_arms: dangerFor(sr, liqShareArms, totalOps, liquidated),
      danger_extortion: dangerFor(sr, liqShareExt,  totalOps, liquidated),
    });
  }

  // Best = lowest danger, Worst = highest danger. Skip hours with null.
  const rank = (key: 'danger_drug' | 'danger_arms' | 'danger_extortion') => {
    const eligible = hours.filter(h => h[key] !== null);
    const sorted = [...eligible].sort((a, b) => (a[key]! - b[key]!));
    return {
      best:  sorted.slice(0, 5).map(h => h.hour_hkt),
      worst: sorted.slice(-5).reverse().map(h => h.hour_hkt),
    };
  };
  const drugRank = rank('danger_drug');
  const armsRank = rank('danger_arms');
  const extRank  = rank('danger_extortion');

  const totalOps = totalCompleted + totalLiquidated;
  const globalSR = totalOps > 0 ? totalCompleted / totalOps : null;
  const allDates = new Set(filtered.map(r => r.date_hkt));

  return {
    hours,
    bestHours:  { drug: drugRank.best,  arms: armsRank.best,  extortion: extRank.best  },
    worstHours: { drug: drugRank.worst, arms: armsRank.worst, extortion: extRank.worst },
    globalSR,
    windowDays: allDates.size,
    generatedAt: Date.now(),
    regime,
  };
}

/**
 * Compute all three regime slices in a single pass. Cheaper than three
 * `computeRolling` calls because each only iterates the input once.
 */
export function computeRollingAllRegimes(rows: NetworkHourlyRow[]): RollingStatsByRegime {
  return {
    all:     computeRolling(rows, 'all'),
    weekday: computeRolling(rows, 'weekday'),
    weekend: computeRolling(rows, 'weekend'),
  };
}
