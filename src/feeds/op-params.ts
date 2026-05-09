// ============================================================
// OpParamsFeed — live sampler of on-chain liquidation thresholds.
//
// Why this exists:
//   The Offshore Protocol contract recalibrates op liquidation
//   thresholds every ~48h based on observed network success rate
//   ("if SR > expected by 20%+, leverage tightens"). It also
//   applies a "weekend leverage" mode Fri evening → Sun evening
//   when realized vol drops. We don't get a notification — only
//   an on-chain effect on every newly-started trade's liqPrice.
//
// Approach:
//   Every POLL_MS we pick N corps that recently TradeCompleted-d
//   (i.e. likely re-bootstrapping into a new active trade), call
//   getTradeInfo() on each, and back out the threshold from
//   (entryPrice − liqPrice) / entryPrice. Median per mode wins.
//
// Persistence:
//   Whenever a mode's median changes vs the last stored value
//   (with a small dedup epsilon to absorb noise), append a row
//   to op_params_history. Caller reads .latest() for the live
//   value used by danger calc, network-health, schedule, etc.
//
// What this REPLACES:
//   - DROP_THRESHOLDS map in volatility.ts
//   - MODE_LIQ_THRESHOLD map in corp-state.ts (the display field;
//     headroom math already uses chain-stored lowerBound directly)
//   - Hardcoded thresholdPct in backtest engine (when re-run)
//   - The "is the network in weekend mode?" inference for the UI
// ============================================================

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { logger } from '../logger';
import type { Storage } from '../storage/db';

const RPC = 'https://mainnet.megaeth.com/rpc';
const TC_TOPIC = '0x35c06e2c02cc93628588ec67d74925fa30de5c693ea264ec67458bb0b65c3bf1';
const SEL_GET_TRADE_INFO = '0xd6694027';

const DEFAULT_POLL_MS = 10 * 60_000;     // 10 min — thresholds change at most every 48h, plus weekend transitions
const SAMPLE_TC_LOOKBACK_BLOCKS = 3600;  // ~1h of TC events to harvest corp candidates
const MAX_CORPS_PER_POLL = 120;          // cap RPC fan-out
const CHANGE_EPSILON = 0.000005;         // 0.0005pp — anything smaller is rounding noise

/**
 * Default fallback values used until the first successful poll. These
 * match the v1 (pre-recalibration) thresholds. The feed overwrites
 * them within ~1 minute of startup.
 */
export const DEFAULT_THRESHOLDS = {
  0: 0.00039, // Extortion 0.039%
  1: 0.00176, // Arms 0.176%
  2: 0.00518, // Drug 0.518%
} as const;

export type OpMode = 0 | 1 | 2;

export interface OpParamsSnapshot {
  ts: number;
  thresholds: Record<OpMode, number>;     // fraction (0.003077 for 0.3077%)
  sampleCounts: Record<OpMode, number>;
  isWeekend: boolean;                     // inferred from HKT day-of-week
  source: 'default' | 'live';
  /**
   * Median INF cost per op observed across active trades. Single global
   * value (the contract uses the same cost for all 3 modes — verified
   * via chain sampling 2026-05-09: Arms median 9.12 INF, Drug 9.17 INF,
   * differences purely from price-snapshot timing). Was historically
   * a flat 5.0 INF; now floats with $DIRTY price.
   *
   * null until first poll completes successfully.
   */
  infCostPerOp: number | null;
  infCostSampleCount: number;
}

function isHktWeekend(now = new Date()): boolean {
  // Per dev: weekend leverage runs Fri evening through Sun evening HKT.
  // Without exact start/end times yet, conservatively treat the entire
  // Fri/Sat/Sun HKT day as weekend. Refine when operator confirms.
  const hkt = new Date(now.getTime() + 8 * 3600_000);
  const dow = hkt.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
  return dow === 0 || dow === 5 || dow === 6;
}

function decodeTradeInfo(hex: string) {
  const h = (hex || '').replace(/^0x/, '');
  if (h.length < 64 * 8) return null;
  // Field order matches src/feeds/corp-state.ts:decodeTradeInfo:
  //   0: active, 1: mode, 2: entryPrice, 3: liqPrice, 4: startTime,
  //   5: endTime, 6: influence, 7: pending
  return {
    active:     parseInt(h.substring(0, 64), 16) === 1,
    mode:       parseInt(h.substring(64, 128), 16),
    entryPrice: BigInt('0x' + h.substring(128, 192)),
    liqPrice:   BigInt('0x' + h.substring(192, 256)),
    startTime:  Number(BigInt('0x' + h.substring(256, 320))),
    influence:  BigInt('0x' + h.substring(384, 448)),
  };
}

function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export interface OpParamsFeedConfig {
  storage: Storage;
  pollMs?: number;
  rpcUrl?: string;
}

export class OpParamsFeed extends EventEmitter {
  private readonly storage: Storage;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private current: OpParamsSnapshot;

  constructor(cfg: OpParamsFeedConfig) {
    super();
    this.storage = cfg.storage;
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl ?? RPC);
    this.pollMs = cfg.pollMs ?? DEFAULT_POLL_MS;

    // Seed from DB if we have prior data; else fall back to v1 defaults.
    const last = this.storage.getLatestOpParams();
    const thresholds: Record<OpMode, number> = {
      0: last[0]?.threshold_pct ?? DEFAULT_THRESHOLDS[0],
      1: last[1]?.threshold_pct ?? DEFAULT_THRESHOLDS[1],
      2: last[2]?.threshold_pct ?? DEFAULT_THRESHOLDS[2],
    };
    const sampleCounts: Record<OpMode, number> = { 0: 0, 1: 0, 2: 0 };
    const anyLive = !!(last[0] || last[1] || last[2]);
    // Seed INF cost from the most recently logged value across any mode.
    // Single global value, so we just take whichever row is freshest.
    const candidateCosts = [last[0]?.inf_cost_per_op, last[1]?.inf_cost_per_op, last[2]?.inf_cost_per_op]
      .filter((x): x is number => typeof x === 'number' && x > 0);
    this.current = {
      ts: Date.now(),
      thresholds,
      sampleCounts,
      isWeekend: isHktWeekend(),
      source: anyLive ? 'live' : 'default',
      infCostPerOp: candidateCosts.length > 0 ? candidateCosts[0] : null,
      infCostSampleCount: 0,
    };
  }

  async start(): Promise<void> {
    // First poll immediately so consumers don't read defaults for 10 min
    try { await this.poll(); } catch (err: any) {
      logger.warn({ err: err.message }, '[OpParams] initial poll failed');
    }
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    this.timer.unref();
    logger.info({ pollMs: this.pollMs }, '[OpParams] started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Live snapshot for downstream consumers. */
  getSnapshot(): OpParamsSnapshot {
    return { ...this.current };
  }

  /** Live threshold for a mode. Always returns a value (default if not yet sampled). */
  getThreshold(mode: OpMode): number {
    return this.current.thresholds[mode];
  }

  // ──────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    const latest = await this.provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - SAMPLE_TC_LOOKBACK_BLOCKS);

    // Harvest distinct corps from recent TC events. They're the ones most
    // likely to be mid-trade right now (auto-bootstrap into next op).
    const corps = new Set<string>();
    for (let f = fromBlock; f <= latest; f += 1500) {
      const t = Math.min(f + 1499, latest);
      try {
        const logs = await this.provider.getLogs({
          fromBlock: f, toBlock: t, topics: [TC_TOPIC],
        });
        for (const log of logs) {
          if (log.topics[2]) corps.add('0x' + log.topics[2].slice(-40));
        }
      } catch { /* skip chunk */ }
    }

    // Cap to keep the call fan-out reasonable.
    const corpArr = [...corps].slice(0, MAX_CORPS_PER_POLL);
    const buckets: Record<OpMode, number[]> = { 0: [], 1: [], 2: [] };
    // Collect influence samples too. Single global pool across modes
    // (the contract uses the same INF cost regardless of op type — the
    // chain sample on 2026-05-09 confirmed Arms median 9.12 vs Drug 9.17,
    // tiny gap from price-snapshot timing rather than a real per-mode
    // difference). Prefer NEWEST samples to reflect current $DIRTY price.
    const infSamples: { inf: number; startedAgo: number }[] = [];
    const nowSec = Math.floor(Date.now() / 1000);

    for (const addr of corpArr) {
      try {
        const raw = await this.provider.call({ to: addr, data: SEL_GET_TRADE_INFO });
        const ti = decodeTradeInfo(raw);
        if (!ti || !ti.active) continue;
        if (ti.entryPrice === 0n || ti.liqPrice === 0n) continue;
        if (!(ti.mode in buckets)) continue;
        const anchor = Number(ti.entryPrice) / 1e18;
        const lower  = Number(ti.liqPrice) / 1e18;
        const thresh = (anchor - lower) / anchor;
        // Sanity: any threshold outside [0.0001, 0.05] is decode noise
        if (thresh > 0.0001 && thresh < 0.05) {
          buckets[ti.mode as OpMode].push(thresh);
        }
        // INF cost — sanity range [0.1, 1000] INF
        if (ti.influence > 0n) {
          const inf = Number(ti.influence) / 1e18;
          const startedAgo = nowSec - ti.startTime;
          if (inf > 0.1 && inf < 1000 && startedAgo >= 0) {
            infSamples.push({ inf, startedAgo });
          }
        }
      } catch { /* skip corp */ }
    }

    const now = Date.now();
    const isWeekend = isHktWeekend(new Date(now));
    const newThresholds: Record<OpMode, number> = { ...this.current.thresholds };
    const newCounts:     Record<OpMode, number> = { 0: 0, 1: 0, 2: 0 };

    // Compute the network-wide INF cost. Use only the freshest samples
    // (last 5 min) to capture current $DIRTY price; older trades locked
    // in at an outdated rate. Falls back to all samples if nothing is
    // fresh (low-activity windows).
    const FRESH_WINDOW_SEC = 5 * 60;
    let freshInf = infSamples.filter(s => s.startedAgo <= FRESH_WINDOW_SEC).map(s => s.inf);
    if (freshInf.length === 0) freshInf = infSamples.map(s => s.inf);
    const newInfCost = freshInf.length > 0 ? median(freshInf) : this.current.infCostPerOp;
    const newInfSampleCount = freshInf.length;

    const persistRows: Parameters<Storage['insertOpParams']>[0] = [];

    for (const m of [0, 1, 2] as const) {
      const samples = buckets[m];
      newCounts[m] = samples.length;
      if (samples.length === 0) continue;
      const med = median(samples);
      newThresholds[m] = med;
      // Persist if threshold changed beyond epsilon, OR if INF cost
      // changed materially (>1%) — same row writes both cols at once.
      const prev = this.current.thresholds[m];
      const threshChanged = Math.abs(med - prev) >= CHANGE_EPSILON;
      const infChanged = newInfCost != null && this.current.infCostPerOp != null
        && Math.abs(newInfCost - this.current.infCostPerOp) / this.current.infCostPerOp >= 0.01;
      const isFirstLive = this.current.source === 'default';
      if (threshChanged || infChanged || isFirstLive) {
        persistRows.push({
          ts: now,
          mode: m,
          threshold_pct: med,
          sample_count: samples.length,
          is_weekend: isWeekend ? 1 : 0,
          inf_cost_per_op: newInfCost,
        });
        if (threshChanged) {
          logger.info(
            { mode: m, prev_pct: (prev * 100).toFixed(4), new_pct: (med * 100).toFixed(4), samples: samples.length, isWeekend },
            '[OpParams] threshold changed',
          );
        }
      }
    }
    if (persistRows.length > 0) {
      this.storage.insertOpParams(persistRows);
    }

    // Log INF cost change as its own line (only once per poll, not per mode)
    if (newInfCost != null && this.current.infCostPerOp != null
        && Math.abs(newInfCost - this.current.infCostPerOp) / this.current.infCostPerOp >= 0.01) {
      logger.info(
        { prev: this.current.infCostPerOp.toFixed(4), new: newInfCost.toFixed(4), samples: newInfSampleCount },
        '[OpParams] INF cost changed',
      );
    }

    this.current = {
      ts: now,
      thresholds: newThresholds,
      sampleCounts: newCounts,
      isWeekend,
      source: 'live',
      infCostPerOp: newInfCost,
      infCostSampleCount: newInfSampleCount,
    };
    this.emit('snapshot', this.current);
  }
}

/**
 * Standalone helper exported for the schedule lookup and other callers
 * that need the weekend determination without instantiating the feed.
 */
export { isHktWeekend };
