// ============================================================
// Empirical operation outcome statistics.
//
// Aggregates the user-logged op outcomes into per-op-type
// statistics that the economics module consumes to override
// the placeholder failure-reward fractions once we have enough
// real samples to be confident.
//
// The key empirical quantity is:
//
//   failureRewardFraction(op) = E[dirty_earned | failure] / E[base_reward | failure]
//
// (i.e., the average partial payout on failures, normalized by
// the base reward at the time of each failure.) This is what
// the dashboard's economics math really wants, and it's the
// only number we can't read from the canonical doc — it has to
// come from observed in-game behavior.
//
// Confidence labels:
//   < 10 samples → "low"      (don't override env defaults)
//   10–49        → "medium"   (override but show a warning)
//   ≥ 50         → "high"     (override with confidence)
// ============================================================

import type { Storage, OpOutcome } from '../storage/db';

export type OpType = 'extortion' | 'arms' | 'drug';

export interface OpTypeStats {
  op: OpType;
  // Counts
  nTotal: number;
  nSuccess: number;
  nFailure: number;
  // Success rate, observed
  successRate: number;          // nSuccess / nTotal
  // Average $DIRTY received per outcome class
  avgDirtyOnSuccess: number;    // null if no successes
  avgDirtyOnFailure: number;    // null if no failures
  // Average base reward per outcome class
  avgBaseSuccess: number;
  avgBaseFailure: number;
  // The number we actually want
  empiricalFailureFraction: number | null; // = avgDirtyOnFailure / avgBaseFailure, null if no failures
  // Confidence + recommended-use flag
  confidence: 'low' | 'medium' | 'high';
  shouldOverrideDefault: boolean;
  // First / last op ts in milliseconds (for "logged X hours ago" UI)
  firstTs: number | null;
  lastTs: number | null;
}

export interface OpStatsBlock {
  extortion: OpTypeStats;
  arms: OpTypeStats;
  drug: OpTypeStats;
  totalLogged: number;
}

const CONFIDENCE_LOW_MAX = 10;       // < this → low
const CONFIDENCE_HIGH_MIN = 50;      // ≥ this → high
const OVERRIDE_MIN = 10;             // ≥ this → start using empirical

function emptyStats(op: OpType): OpTypeStats {
  return {
    op,
    nTotal: 0,
    nSuccess: 0,
    nFailure: 0,
    successRate: 0,
    avgDirtyOnSuccess: 0,
    avgDirtyOnFailure: 0,
    avgBaseSuccess: 0,
    avgBaseFailure: 0,
    empiricalFailureFraction: null,
    confidence: 'low',
    shouldOverrideDefault: false,
    firstTs: null,
    lastTs: null,
  };
}

function aggregate(rows: OpOutcome[], op: OpType): OpTypeStats {
  const stats = emptyStats(op);
  if (rows.length === 0) return stats;

  let dirtySuccessSum = 0, dirtyFailureSum = 0;
  let baseSuccessSum = 0, baseFailureSum = 0;
  let firstTs = Infinity, lastTs = -Infinity;

  for (const r of rows) {
    if (r.succeeded === 1) {
      stats.nSuccess++;
      dirtySuccessSum += r.dirtyEarned;
      baseSuccessSum += r.baseReward;
    } else {
      stats.nFailure++;
      dirtyFailureSum += r.dirtyEarned;
      baseFailureSum += r.baseReward;
    }
    if (r.ts < firstTs) firstTs = r.ts;
    if (r.ts > lastTs) lastTs = r.ts;
  }

  stats.nTotal = stats.nSuccess + stats.nFailure;
  stats.successRate = stats.nTotal > 0 ? stats.nSuccess / stats.nTotal : 0;
  stats.avgDirtyOnSuccess = stats.nSuccess > 0 ? dirtySuccessSum / stats.nSuccess : 0;
  stats.avgDirtyOnFailure = stats.nFailure > 0 ? dirtyFailureSum / stats.nFailure : 0;
  stats.avgBaseSuccess = stats.nSuccess > 0 ? baseSuccessSum / stats.nSuccess : 0;
  stats.avgBaseFailure = stats.nFailure > 0 ? baseFailureSum / stats.nFailure : 0;

  // Empirical failure fraction = mean partial reward on failure / mean base reward on failure.
  // We normalize by base because the player's PL (and thus base reward) may
  // change over the logging window — using the per-outcome base avoids bias.
  if (stats.nFailure > 0 && stats.avgBaseFailure > 0) {
    stats.empiricalFailureFraction = stats.avgDirtyOnFailure / stats.avgBaseFailure;
    // Clamp to [0, 1] — defensive against typos
    stats.empiricalFailureFraction = Math.min(1, Math.max(0, stats.empiricalFailureFraction));
  } else {
    stats.empiricalFailureFraction = null;
  }

  // Confidence by total sample size (we want failures specifically for the
  // fraction estimate, but total sample also matters for success-rate calibration)
  const n = stats.nTotal;
  stats.confidence = n < CONFIDENCE_LOW_MAX ? 'low'
                   : n < CONFIDENCE_HIGH_MIN ? 'medium'
                   : 'high';

  // Only override default if we have enough samples AND at least one failure
  // (otherwise we can't measure the fraction at all).
  stats.shouldOverrideDefault = n >= OVERRIDE_MIN && stats.nFailure > 0;

  stats.firstTs = firstTs === Infinity ? null : firstTs;
  stats.lastTs = lastTs === -Infinity ? null : lastTs;

  return stats;
}

/**
 * Compute per-op stats from the storage layer. Pulls the most recent N
 * outcomes per type (default 500) so the "empirical fraction" reflects
 * recent gameplay and shifts as the player levels up or game balance
 * changes, rather than getting stuck on stale early-game data.
 */
export function buildOpStats(storage: Storage, perTypeLimit = 500): OpStatsBlock {
  const ext = storage.getOpOutcomes({ opType: 'extortion', limit: perTypeLimit });
  const arms = storage.getOpOutcomes({ opType: 'arms', limit: perTypeLimit });
  const drug = storage.getOpOutcomes({ opType: 'drug', limit: perTypeLimit });

  return {
    extortion: aggregate(ext, 'extortion'),
    arms: aggregate(arms, 'arms'),
    drug: aggregate(drug, 'drug'),
    totalLogged: ext.length + arms.length + drug.length,
  };
}

/**
 * Build a record { op → empirical fraction } that the economics module
 * can consume to override its env-default failureRewardFraction values.
 * Only includes ops where shouldOverrideDefault is true.
 */
export function getEmpiricalFractions(stats: OpStatsBlock): Partial<Record<OpType, number>> {
  const out: Partial<Record<OpType, number>> = {};
  for (const op of ['extortion', 'arms', 'drug'] as const) {
    const s = stats[op];
    if (s.shouldOverrideDefault && s.empiricalFailureFraction !== null) {
      out[op] = s.empiricalFailureFraction;
    }
  }
  return out;
}
