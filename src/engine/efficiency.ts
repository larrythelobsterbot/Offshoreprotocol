// ============================================================
// Efficiency engine — DIRTY-per-INF analysis + schedule audit.
//
// Why this matters: success rate (SR) is misleading for Drug ops
// because TradeLiquidated events still pay PARTIAL DIRTY via the
// progressive-payout mechanic. A 50%-SR Arms hour can earn more
// DIRTY/INF than a 75%-SR Drug hour if the partial payouts on
// failed Arms cover the cycle-frequency gap.
//
// Core query: op_outcomes joined on (corp, ts) to itself for
// hour buckets and op_type slices. We use op_type as the primary
// grouping signal because it's 100% populated, while the `strategy`
// column is sparse (only ~5% — bot rarely calls explicit
// startTrade(); most ops auto-restart at the contract level after
// completeTrade()).
//
// Two endpoints driven by this engine:
//   /api/efficiency       — raw DIRTY/INF rollups (overall, hourly, op_type, strategy)
//   /api/schedule-audit   — actual vs all-Drug baseline per scheduled hour
// ============================================================

import type { Storage } from '../storage/db';
import { isHktWeekendHour } from '../feeds/schedule-evidence';

const HKT_OFFSET_MS = 8 * 3600_000;

/** Convert a UTC ms to HKT date+hour parts. */
function toHkt(tsMs: number): { date: string; hour: number } {
  const d = new Date(tsMs + HKT_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
  };
}

export type Regime = 'all' | 'weekday' | 'weekend' | 'split';

export interface EfficiencyBucket {
  ops: number;
  wins: number;
  /** Net INF burned (refund-on-success modeled). Successes contribute 0. */
  inf_spent: number;
  dirty_earned: number;
  /**
   * dirty_earned / inf_spent. Can be `Infinity` when wins>0 and inf_spent==0
   * (every op succeeded — operator never lost any INF). Renderers must
   * check `Number.isFinite()` and display "∞ / no losses" appropriately.
   * Comparators that rank dirty_per_inf should treat Infinity as max.
   */
  dirty_per_inf: number;
  sr: number;
  avg_partial_payout: number;  // avg DIRTY on FAILED ops (ops where succeeded=0)
}

export interface HourEfficiencyRow extends EfficiencyBucket {
  hkt_hour: number;
  regime: 'weekday' | 'weekend';
}

export interface StrategyEfficiencyRow extends EfficiencyBucket {
  strategy: string;
}

export interface OpTypeEfficiencyRow extends EfficiencyBucket {
  op_type: 'extortion' | 'arms' | 'drug';
}

export interface EfficiencySnapshot {
  generatedAt: number;
  windowHours: number;
  regime: Regime;
  // Sample / quality flags so the UI can warn about thin data or
  // stale inf_cost values.
  sampleNote: string | null;
  /** Across the whole window, regardless of regime filter. */
  overall: EfficiencyBucket;
  /** Per HKT hour. When regime=split, this contains up to 48 rows (24 weekday + 24 weekend). */
  by_hour: HourEfficiencyRow[];
  /** Per op_type (drug/arms/extortion) — denser than strategy. */
  by_op_type: OpTypeEfficiencyRow[];
  /** Per strategy preset — sparse; only present for explicitly bootstrapped ops. */
  by_strategy: StrategyEfficiencyRow[];
}

// Mirrors the camelCase shape returned by Storage.getOpOutcomesSince().
interface OpOutcomeRow {
  ts: number;
  opType: 'extortion' | 'arms' | 'drug';
  succeeded: 0 | 1;
  dirtyEarned: number;
  /** Stake at risk — burned at startTrade(). Refunded on success. */
  infCost: number | null;
  /** Net INF actually consumed: 0 on success (refunded), inf_cost on failure. */
  infBurned: number | null;
  strategy: string | null;
}

/**
 * Fold a row into a mutable bucket. Doesn't compute averages — call finalize().
 *
 * inf_spent semantics changed 2026-05-10 (CLAUDE.md lesson #27):
 * we now track NET INF burned (refund-on-success modeled), not stake-
 * at-risk. Successful ops contribute 0 to inf_spent, failures contribute
 * the full inf_cost. DIRTY/INF then represents "DIRTY earned per INF
 * actually consumed" — the right decision metric. The previous model
 * understated DIRTY/INF by ~3x for high-SR strategies.
 */
function accumulate(b: EfficiencyBucket, r: OpOutcomeRow) {
  b.ops += 1;
  b.wins += r.succeeded;
  // Prefer inf_burned (post-migration). Fall back to deriving from
  // inf_cost + succeeded for any rare row that predates the column.
  const burned = r.infBurned != null
    ? r.infBurned
    : r.infCost != null
      ? (r.succeeded ? 0 : r.infCost)
      : 0;
  b.inf_spent += burned;
  b.dirty_earned += r.dirtyEarned;
  if (!r.succeeded) {
    b.avg_partial_payout += r.dirtyEarned;
  }
}

function emptyBucket(): EfficiencyBucket {
  return {
    ops: 0, wins: 0, inf_spent: 0, dirty_earned: 0,
    dirty_per_inf: 0, sr: 0, avg_partial_payout: 0,
  };
}

/** Compute derived ratios after accumulation. Mutates in place. */
function finalize(b: EfficiencyBucket): void {
  // dirty_per_inf cases:
  //   ops=0                   → 0      (no data)
  //   inf_spent>0             → divide (normal case)
  //   inf_spent==0 && wins>0  → ∞      (every op succeeded, no INF lost — "no losses")
  //   inf_spent==0 && wins==0 → 0      (degenerate; shouldn't happen with real ops)
  if (b.ops === 0) {
    b.dirty_per_inf = 0;
  } else if (b.inf_spent > 0) {
    b.dirty_per_inf = b.dirty_earned / b.inf_spent;
  } else if (b.wins > 0) {
    b.dirty_per_inf = Infinity;
  } else {
    b.dirty_per_inf = 0;
  }
  b.sr                 = b.ops > 0 ? b.wins / b.ops : 0;
  const losses         = b.ops - b.wins;
  // avg_partial_payout currently holds the SUM of failed DIRTY → divide
  b.avg_partial_payout = losses > 0 ? b.avg_partial_payout / losses : 0;
}

/**
 * Pull op_outcomes within window and compute all the rollups in one pass.
 * The brief asked us to join op_outcomes ↔ bootstrap_log but in practice
 * op_outcomes already carries the strategy + corp + inf_cost columns
 * (the join was done at insert time by the op-scraper). So we just query
 * op_outcomes directly.
 */
export function computeEfficiency(
  storage: Storage,
  opts: { windowHours: number; regime?: Regime } = { windowHours: 24 },
): EfficiencySnapshot {
  const regime = opts.regime ?? 'all';
  const sinceMs = Date.now() - opts.windowHours * 3600_000;

  // Storage exposes raw rows — strategy attribution helper is too
  // pre-aggregated for our needs. Reach into the prepared statement
  // mechanism via getOpOutcomesSince which returns chronological rows.
  const rows = storage.getOpOutcomesSince(sinceMs) as unknown as OpOutcomeRow[];

  // Optional regime filter
  const filtered: OpOutcomeRow[] = [];
  for (const r of rows) {
    if (regime === 'all' || regime === 'split') {
      filtered.push(r);
    } else {
      const { date, hour } = toHkt(r.ts);
      const isWk = isHktWeekendHour(date, hour);
      if ((regime === 'weekend' && isWk) || (regime === 'weekday' && !isWk)) {
        filtered.push(r);
      }
    }
  }

  // Overall
  const overall = emptyBucket();
  for (const r of filtered) accumulate(overall, r);
  finalize(overall);

  // By hour (× regime when split). Key: `${hour}|${weekend}`.
  const hourMap = new Map<string, HourEfficiencyRow>();
  for (const r of filtered) {
    const { date, hour } = toHkt(r.ts);
    const isWk = isHktWeekendHour(date, hour);
    const regimeKey: 'weekday' | 'weekend' = isWk ? 'weekend' : 'weekday';
    // When regime=split, key by both. Otherwise the hour bucket is
    // pre-filtered above, so collapse to one row per hour with the
    // dominant regime label (if mixed, just tag 'weekday' for stability).
    const key = regime === 'split' ? `${hour}|${regimeKey}` : `${hour}|${regimeKey}`;
    let row = hourMap.get(key);
    if (!row) {
      row = { ...emptyBucket(), hkt_hour: hour, regime: regimeKey };
      hourMap.set(key, row);
    }
    accumulate(row, r);
  }
  const byHour = [...hourMap.values()];
  for (const row of byHour) finalize(row);
  byHour.sort((a, b) =>
    a.hkt_hour - b.hkt_hour || (a.regime === b.regime ? 0 : a.regime === 'weekday' ? -1 : 1),
  );

  // By op_type
  const opTypeMap = new Map<'extortion' | 'arms' | 'drug', OpTypeEfficiencyRow>();
  for (const r of filtered) {
    let row = opTypeMap.get(r.opType);
    if (!row) {
      row = { ...emptyBucket(), op_type: r.opType };
      opTypeMap.set(r.opType, row);
    }
    accumulate(row, r);
  }
  const byOpType = [...opTypeMap.values()];
  for (const row of byOpType) finalize(row);
  byOpType.sort((a, b) => b.dirty_per_inf - a.dirty_per_inf);

  // By strategy (sparse)
  const stratMap = new Map<string, StrategyEfficiencyRow>();
  for (const r of filtered) {
    if (!r.strategy) continue;
    let row = stratMap.get(r.strategy);
    if (!row) {
      row = { ...emptyBucket(), strategy: r.strategy };
      stratMap.set(r.strategy, row);
    }
    accumulate(row, r);
  }
  const byStrategy = [...stratMap.values()];
  for (const row of byStrategy) finalize(row);
  byStrategy.sort((a, b) => b.dirty_per_inf - a.dirty_per_inf);

  // Sample-note: warn the operator about known gotchas.
  let sampleNote: string | null = null;
  const stratCoverage = byStrategy.reduce((s, r) => s + r.ops, 0);
  if (overall.ops > 0 && stratCoverage / overall.ops < 0.2) {
    sampleNote =
      `Strategy attribution covers ${((stratCoverage / overall.ops) * 100).toFixed(0)}% of ops ` +
      `(${stratCoverage}/${overall.ops}). Most ops auto-restart at the contract level without ` +
      `an explicit bot startTrade() call, so they don't get tagged. by_op_type is the denser signal.`;
  }

  return {
    generatedAt: Date.now(),
    windowHours: opts.windowHours,
    regime,
    sampleNote,
    overall,
    by_hour: byHour,
    by_op_type: byOpType,
    by_strategy: byStrategy,
  };
}

// ── Schedule audit ──────────────────────────────────────────

export interface ScheduleAuditRow {
  hkt_hour: number;
  scheduled_preset: string;        // 'all-drug' | 'all-arms' | 'paused' | etc.
  regime: 'weekday' | 'weekend';
  // Actual performance during this slot (in our window, in this regime)
  actual_dirty_per_inf: number;
  actual_sr: number;
  actual_ops: number;
  // All-Drug baseline for the same hour + regime — answers
  // "could we have done better by running Drug at this hour?"
  baseline_drug_dirty_per_inf: number | null;
  baseline_drug_sr: number | null;
  baseline_drug_ops: number;
  // Delta in % vs baseline. Negative = underperforming Drug.
  delta_pct: number | null;
  recommendation: string;
  sample_size: number;
  flag: 'ok' | 'underperforming' | 'insufficient_data';
}

export interface ScheduleAuditSnapshot {
  generatedAt: number;
  windowHours: number;
  schedule: string[];          // 24-element array from CorpBot
  audit: ScheduleAuditRow[];
}

/**
 * For each (hour, regime) slot in the schedule, compare the slot's
 * ACTUAL DIRTY/INF (across all op_types that ran) against the all-Drug
 * baseline DIRTY/INF for the same hour + regime. Flag slots that:
 *   • underperform Drug by >10% with sample size ≥ 5  →  'underperforming'
 *   • have <5 ops in window                            →  'insufficient_data'
 *   • everything else                                  →  'ok'
 *
 * The current schedule is hour-only (single 24-element array). We
 * audit BOTH regimes for each slot so the operator can see when a slot
 * is failing weekday vs weekend separately. Future work: regime-aware
 * schedule with two arrays. Until then, the schedule shown is the same
 * for both regimes.
 */
export function computeScheduleAudit(
  storage: Storage,
  schedule: string[],
  opts: { windowHours: number; minOpsForFlag?: number; underperfThreshold?: number } = { windowHours: 7 * 24 },
): ScheduleAuditSnapshot {
  const minOps = opts.minOpsForFlag ?? 5;
  const underperfThreshold = opts.underperfThreshold ?? 10;  // %
  const sinceMs = Date.now() - opts.windowHours * 3600_000;
  const rows = storage.getOpOutcomesSince(sinceMs) as unknown as OpOutcomeRow[];

  // Group by (hour, regime). Track all ops + drug-only ops separately.
  type Slot = { all: EfficiencyBucket; drug: EfficiencyBucket };
  const slots = new Map<string, Slot>();
  const slotKey = (hour: number, regime: 'weekday' | 'weekend') => `${hour}|${regime}`;

  for (const r of rows) {
    const { date, hour } = toHkt(r.ts);
    const regime: 'weekday' | 'weekend' = isHktWeekendHour(date, hour) ? 'weekend' : 'weekday';
    const key = slotKey(hour, regime);
    let slot = slots.get(key);
    if (!slot) {
      slot = { all: emptyBucket(), drug: emptyBucket() };
      slots.set(key, slot);
    }
    accumulate(slot.all, r);
    if (r.opType === 'drug') accumulate(slot.drug, r);
  }
  for (const slot of slots.values()) {
    finalize(slot.all);
    finalize(slot.drug);
  }

  const audit: ScheduleAuditRow[] = [];
  for (let hour = 0; hour < 24; hour++) {
    for (const regime of ['weekday', 'weekend'] as const) {
      const slot = slots.get(slotKey(hour, regime));
      const actualOps = slot?.all.ops ?? 0;
      const actualDpi = slot?.all.dirty_per_inf ?? 0;
      const actualSr = slot?.all.sr ?? 0;
      const drugOps = slot?.drug.ops ?? 0;
      const drugDpi = drugOps > 0 ? slot!.drug.dirty_per_inf : null;
      const drugSr  = drugOps > 0 ? slot!.drug.sr : null;

      // delta_pct = how much actual dpi differs from drug baseline
      // (positive = beating Drug; negative = lagging).
      // Special cases (post refund-on-success fix):
      //   actualDpi = ∞, drugDpi = ∞       → both perfect, delta = 0
      //   actualDpi = ∞, drugDpi finite    → actual is "no losses" → strictly better, delta = +∞ (clamped to large for sort)
      //   actualDpi finite, drugDpi = ∞    → drug had no losses, actual lagging by definition → -100% (sentinel)
      //   both finite & drugDpi > 0        → standard pct delta
      //   drugDpi = 0 (drug ops all yielded zero) → delta null
      let deltaPct: number | null = null;
      if (drugDpi != null) {
        if (!Number.isFinite(actualDpi) && !Number.isFinite(drugDpi)) {
          deltaPct = 0;
        } else if (!Number.isFinite(actualDpi)) {
          deltaPct = Infinity;
        } else if (!Number.isFinite(drugDpi)) {
          deltaPct = -100;
        } else if (drugDpi > 0) {
          deltaPct = ((actualDpi - drugDpi) / drugDpi) * 100;
        }
      }

      let flag: ScheduleAuditRow['flag'] = 'ok';
      let recommendation = 'no change';
      const preset = schedule[hour] ?? 'unknown';

      if (actualOps < minOps) {
        flag = 'insufficient_data';
        recommendation = `insufficient data (n=${actualOps}, need ≥${minOps})`;
      } else if (
        preset !== 'all-drug' &&
        drugDpi != null &&
        deltaPct != null &&
        Number.isFinite(deltaPct) &&
        deltaPct < -underperfThreshold
      ) {
        flag = 'underperforming';
        recommendation = `switch to all-drug (${deltaPct.toFixed(1)}% below Drug baseline)`;
      } else if (
        preset === 'all-drug' &&
        deltaPct != null &&
        Number.isFinite(deltaPct) &&
        deltaPct < -underperfThreshold &&
        drugOps < actualOps * 0.7
      ) {
        // Slot is 'all-drug' but most ops weren't drug — bot probably mid-mode-switch.
        flag = 'ok';
        recommendation = `mostly-drug already (n_drug=${drugOps}/${actualOps})`;
      }

      audit.push({
        hkt_hour: hour,
        scheduled_preset: preset,
        regime,
        actual_dirty_per_inf: actualDpi,
        actual_sr: actualSr,
        actual_ops: actualOps,
        baseline_drug_dirty_per_inf: drugDpi,
        baseline_drug_sr: drugSr,
        baseline_drug_ops: drugOps,
        delta_pct: deltaPct,
        recommendation,
        sample_size: actualOps,
        flag,
      });
    }
  }

  return {
    generatedAt: Date.now(),
    windowHours: opts.windowHours,
    schedule: [...schedule],
    audit,
  };
}
