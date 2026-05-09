// ============================================================
// NetworkHealthFeed — live game-internal cascade detector.
//
// Polls TradeCompleted (TC) + TradeLiquidated (TL) events network-wide
// every 60s, scanning the last ~10 minutes (~600 blocks). Maintains a
// per-event in-memory ring keyed by event timestamp so we can compute
// rolling 60s / 5min / 15min stats on demand.
//
// Why this exists (vs the existing CEX `liqVelocity`):
//   CEX perp liquidations fire at random leverage levels. Game TLs fire
//   ONLY at the three Offshore thresholds (0.039% / 0.176% / 0.518%).
//   When game-Drug TLs are spiking, that's a leverage-matched signal
//   that ETH is currently moving more than 0.518% in a 90min window —
//   the EXACT risk a Drug op faces. CEX liqVelocity is informative but
//   leverage-mismatched.
//
// Op-type classification: TL events have `durationOrTicks` in data[2].
//
// KNOWN LIMITATION (2026-05-08): the duration field is the TIME-TO-LIQ,
// not the configured op WINDOW. A Drug op that liquidates after 47s
// reports 47s — looks like 'unknown' to classifyDuration's bands.
// Empirically, ~85% of TLs in cascade conditions land in 'unknown'.
//
// Impact: per-op-type trips (TRIP_DRUG_LIQS_5MIN / TRIP_ARMS_LIQS_5MIN)
// rarely fire because the count attribution is broken; the
// cascade-all path catches everything anyway. Trip logic still works
// — just loses op-type granularity. To fix properly, query each
// corp's tradeInfo() at the TL block (1 extra RPC per event).
// Tracked as a follow-up; not blocking shadow-mode deploy.
//
// Shadow mode: when SHADOW=true (default), the feed computes its trip
// decision and writes to defense_shadow_log but does NOT broadcast a
// pause signal. Flip via env (`NETWORK_HEALTH_SHADOW=0`) once we've
// validated precision/recall against op_outcomes.
// ============================================================

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { logger } from '../logger';
import type { Storage } from '../storage/db';

const RPC = 'https://mainnet.megaeth.com/rpc';
const TC_TOPIC = '0x35c06e2c02cc93628588ec67d74925fa30de5c693ea264ec67458bb0b65c3bf1';
const TL_TOPIC = '0xbc95a830b1019b9734680ca35152c5632ef54d080bfa3a55531b755867397678';
const SECS_PER_BLOCK = 1;

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_LOOKBACK_BLOCKS = 600;       // ~10 min, more than the 5-min trip window
const RING_RETAIN_MS = 30 * 60_000;        // keep 30 min of events in memory

// Trip thresholds — calibrated from 7-day evidence sample (31,849 ops):
//   - Median Drug liquidations across all hours = ~6/5min during quiet
//   - 21:00 HKT bloodbath today = 89 Drug liqs/day = ~6/5min average,
//     bursts to 15+/5min during peak cascade
//   - 12 Drug liqs/5min = ~2× the worst-hour average → strong signal
const TRIP_DRUG_LIQS_5MIN     = 12;
const TRIP_ARMS_LIQS_5MIN     = 25;        // Arms volume is ~5× Drug
const TRIP_TOTAL_LIQS_5MIN    = 50;        // overall cascade
const TRIP_VELOCITY_RAMP      = 3.0;       // 60s rate must exceed 3× the 5min avg-rate
const MIN_5MIN_FOR_RAMP_TRIP  = 5;         // need ≥5 events in last 5min before ramp matters

export type OpType = 'extortion' | 'arms' | 'drug' | 'unknown';

function classifyDuration(durationSec: number): OpType {
  if (durationSec >= 240 && durationSec <= 360) return 'extortion';
  if (durationSec >= 1440 && durationSec <= 2160) return 'arms';
  if (durationSec >= 4320 && durationSec <= 6480) return 'drug';
  return 'unknown';
}

interface RingEvent {
  ts: number;            // ms (block-derived)
  kind: 'tc' | 'tl';
  opType: OpType;        // 'unknown' for TC events (we can't classify cheaply)
}

export type CascadeRisk = 'safe' | 'elevated' | 'critical';

export interface NetworkHealthSnapshot {
  scannedAt: number;
  // Rolling counts
  tc5min: number;
  tl5min: number;
  tl1min: number;
  tlDrug5min: number;
  tlArms5min: number;
  tlExt5min: number;
  // Per-op-type velocities (events/min observed in last 60s)
  velDrugPerMin: number;
  velArmsPerMin: number;
  velExtPerMin: number;
  // Network success rate over the 5min window
  networkSR5min: number | null;
  // Trip decisions (always computed; bot only acts when shadow=false)
  cascadeRisk: CascadeRisk;
  drugRisk: CascadeRisk;
  armsRisk: CascadeRisk;
  // Reason string for dashboard / TG / shadow log
  reason: string | null;
  // Did the last evaluation result in a "would-pause" decision?
  wouldPause: boolean;
  wouldPauseOpType: 'drug' | 'arms' | 'extortion' | null; // which op type to pause (null = all)
  // Operating mode
  shadow: boolean;
}

export interface NetworkHealthConfig {
  storage: Storage;
  pollMs?: number;
  shadow?: boolean;          // when true, log decisions but emit no pause signal
  rpcUrl?: string;
}

export class NetworkHealthFeed extends EventEmitter {
  private readonly storage: Storage;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly pollMs: number;
  public readonly shadow: boolean;       // public for /api/state introspection
  private timer: NodeJS.Timeout | null = null;
  private lastBlockScanned: number | null = null;
  private readonly ring: RingEvent[] = [];
  private latestSnapshot: NetworkHealthSnapshot | null = null;
  private prevWouldPause = false;        // for transition-edge alerts

  constructor(cfg: NetworkHealthConfig) {
    super();
    this.storage = cfg.storage;
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl ?? RPC);
    this.pollMs = cfg.pollMs ?? DEFAULT_POLL_MS;
    this.shadow = cfg.shadow ?? true;
  }

  async start(): Promise<void> {
    // First tick is heavier — initial 10min lookback to seed the ring.
    try { await this.tick(true); } catch (err: any) {
      logger.warn({ err: err.message }, '[NetworkHealth] initial tick failed');
    }
    this.timer = setInterval(() => { void this.tick(false); }, this.pollMs);
    this.timer.unref();
    logger.info(
      { shadow: this.shadow, pollMs: this.pollMs },
      '[NetworkHealth] started',
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Most recent snapshot for /api/state and the dashboard. */
  getSnapshot(): NetworkHealthSnapshot | null { return this.latestSnapshot; }

  // ──────────────────────────────────────────────────────────────────

  private async tick(initial: boolean): Promise<void> {
    const latestBlock = await this.provider.getBlock('latest');
    if (!latestBlock) return;
    const latestNum = latestBlock.number;
    const latestTsMs = Number(latestBlock.timestamp) * 1000;

    // Determine scan range. On first tick → 10min lookback. On steady-state
    // → from `lastBlockScanned + 1` to latest.
    const fromBlock = initial || this.lastBlockScanned == null
      ? Math.max(0, latestNum - DEFAULT_LOOKBACK_BLOCKS)
      : this.lastBlockScanned + 1;
    if (fromBlock > latestNum) return;
    const toBlock = latestNum;

    // RPC: chunked at MegaETH's typical 5000-block ceiling. 600 blocks is
    // way under, so a single getLogs call is fine in steady state.
    try {
      const tcLogs = await this.provider.getLogs({ fromBlock, toBlock, topics: [TC_TOPIC] });
      for (const log of tcLogs) {
        const tsMs = latestTsMs - (latestNum - log.blockNumber) * SECS_PER_BLOCK * 1000;
        this.ring.push({ ts: tsMs, kind: 'tc', opType: 'unknown' });
      }
    } catch (err: any) {
      logger.debug({ err: err.message, fromBlock, toBlock }, '[NetworkHealth] TC chunk failed');
    }
    try {
      const tlLogs = await this.provider.getLogs({ fromBlock, toBlock, topics: [TL_TOPIC] });
      for (const log of tlLogs) {
        if (log.topics.length < 4) continue;
        const tsMs = latestTsMs - (latestNum - log.blockNumber) * SECS_PER_BLOCK * 1000;
        let opType: OpType = 'unknown';
        if (log.data && log.data.length >= 194) {
          try {
            const durationSec = Number(BigInt('0x' + log.data.slice(130, 194)));
            opType = classifyDuration(durationSec);
          } catch { /* skip */ }
        }
        this.ring.push({ ts: tsMs, kind: 'tl', opType });
      }
    } catch (err: any) {
      logger.debug({ err: err.message, fromBlock, toBlock }, '[NetworkHealth] TL chunk failed');
    }

    this.lastBlockScanned = toBlock;
    this.pruneRing();
    const snap = this.computeSnapshot();
    this.latestSnapshot = snap;

    // Emit transition-edge alerts (caller wires to TG / dashboard)
    if (snap.wouldPause !== this.prevWouldPause) {
      this.emit('transition', { wouldPause: snap.wouldPause, snapshot: snap });
      this.prevWouldPause = snap.wouldPause;
    }
    this.emit('snapshot', snap);

    // Persist to shadow log when relevant. We only log TRIP events to
    // avoid filling the table — non-trip ticks at 60s would create
    // 1,440 rows/day per signal.
    if (snap.wouldPause) {
      this.storage.insertShadowEvent({
        ts: Date.now(),
        signal: 'network_health',
        would_pause: true,
        reason: snap.reason || 'unknown',
        op_type_filter: snap.wouldPauseOpType,
        context_json: {
          tc5min: snap.tc5min,
          tl5min: snap.tl5min,
          tl1min: snap.tl1min,
          tlDrug5min: snap.tlDrug5min,
          tlArms5min: snap.tlArms5min,
          velDrugPerMin: snap.velDrugPerMin,
          velArmsPerMin: snap.velArmsPerMin,
          networkSR5min: snap.networkSR5min,
          shadow: snap.shadow,
        },
      });
    }
  }

  private pruneRing(): void {
    const cutoff = Date.now() - RING_RETAIN_MS;
    // ring is roughly sorted; do a stable filter
    let i = 0;
    while (i < this.ring.length && this.ring[i].ts < cutoff) i++;
    if (i > 0) this.ring.splice(0, i);
  }

  private computeSnapshot(): NetworkHealthSnapshot {
    const now = Date.now();
    const w5  = now - 5 * 60_000;
    const w1  = now - 1 * 60_000;

    let tc5 = 0, tl5 = 0, tl1 = 0;
    let tlDrug5 = 0, tlArms5 = 0, tlExt5 = 0;
    let tlDrug1 = 0, tlArms1 = 0, tlExt1 = 0;

    for (const e of this.ring) {
      if (e.ts < w5) continue;
      if (e.kind === 'tc') tc5++;
      else {
        tl5++;
        if (e.opType === 'drug') tlDrug5++;
        else if (e.opType === 'arms') tlArms5++;
        else if (e.opType === 'extortion') tlExt5++;
        if (e.ts >= w1) {
          tl1++;
          if (e.opType === 'drug') tlDrug1++;
          else if (e.opType === 'arms') tlArms1++;
          else if (e.opType === 'extortion') tlExt1++;
        }
      }
    }

    // Velocities: events/min observed over last 60s (rate at this instant)
    const velDrugPerMin = tlDrug1;     // 60s window → events count IS per-minute
    const velArmsPerMin = tlArms1;
    const velExtPerMin  = tlExt1;

    // 5min average rate per minute
    const avgDrugPerMin5 = tlDrug5 / 5;
    const avgArmsPerMin5 = tlArms5 / 5;

    // Ramp ratios (60s rate vs 5min avg)
    const rampDrug = avgDrugPerMin5 > 0 ? velDrugPerMin / avgDrugPerMin5 : 0;
    const rampArms = avgArmsPerMin5 > 0 ? velArmsPerMin / avgArmsPerMin5 : 0;

    const totalOps5 = tc5 + tl5;
    const networkSR = totalOps5 > 0 ? tc5 / totalOps5 : null;

    // Trip logic — DRUG specific
    let drugRisk: CascadeRisk = 'safe';
    if (tlDrug5 >= TRIP_DRUG_LIQS_5MIN) drugRisk = 'critical';
    else if (tlDrug5 >= MIN_5MIN_FOR_RAMP_TRIP && rampDrug >= TRIP_VELOCITY_RAMP) drugRisk = 'critical';
    else if (tlDrug5 >= TRIP_DRUG_LIQS_5MIN / 2) drugRisk = 'elevated';

    // ARMS specific
    let armsRisk: CascadeRisk = 'safe';
    if (tlArms5 >= TRIP_ARMS_LIQS_5MIN) armsRisk = 'critical';
    else if (tlArms5 >= MIN_5MIN_FOR_RAMP_TRIP && rampArms >= TRIP_VELOCITY_RAMP) armsRisk = 'critical';
    else if (tlArms5 >= TRIP_ARMS_LIQS_5MIN / 2) armsRisk = 'elevated';

    // GLOBAL cascade
    let cascadeRisk: CascadeRisk = 'safe';
    if (tl5 >= TRIP_TOTAL_LIQS_5MIN) cascadeRisk = 'critical';
    else if (tl5 >= TRIP_TOTAL_LIQS_5MIN / 2) cascadeRisk = 'elevated';

    // Decide pause. wouldPauseOpType uses the storage-narrow type (no
    // 'unknown') because the shadow log column has a CHECK that excludes
    // unknown — by construction we only set this to a classifiable type.
    let wouldPause = false;
    let wouldPauseOpType: 'drug' | 'arms' | 'extortion' | null = null;
    let reason: string | null = null;
    if (cascadeRisk === 'critical') {
      wouldPause = true;
      wouldPauseOpType = null;
      reason = `cascade-all (${tl5} liqs in 5min, vel ${tl1}/min)`;
    } else if (drugRisk === 'critical') {
      wouldPause = true;
      wouldPauseOpType = 'drug';
      reason = `drug-cascade (${tlDrug5} Drug liqs in 5min, ramp ×${rampDrug.toFixed(1)})`;
    } else if (armsRisk === 'critical') {
      wouldPause = true;
      wouldPauseOpType = 'arms';
      reason = `arms-cascade (${tlArms5} Arms liqs in 5min, ramp ×${rampArms.toFixed(1)})`;
    }

    return {
      scannedAt: now,
      tc5min: tc5,
      tl5min: tl5,
      tl1min: tl1,
      tlDrug5min: tlDrug5,
      tlArms5min: tlArms5,
      tlExt5min: tlExt5,
      velDrugPerMin,
      velArmsPerMin,
      velExtPerMin,
      networkSR5min: networkSR,
      cascadeRisk,
      drugRisk,
      armsRisk,
      reason,
      wouldPause,
      wouldPauseOpType,
      shadow: this.shadow,
    };
  }
}
