// ============================================================
// Operation economics — expected $DIRTY per op and per Influence.
//
// Per the on-chain mechanic (see CLAUDE.md lesson #27):
//   - All ops cost some live INF amount (from OpParamsFeed) burned at
//     startTrade(). Was historically a flat 5 INF; now floats with
//     $DIRTY price (~9-12 INF as of 2026-05-09).
//   - **Influence is REFUNDED on success** via a mint-from-0x0 ~3
//     blocks after the TradeCompleted event. Player ends up netting
//     0 INF cost on a winning op.
//   - **Influence is FORFEITED on failure** (no refund on TL).
//   - Success pays 100-130 $DIRTY based on Power Level.
//   - Extortion: BINARY. Failure pays 0 $DIRTY.
//   - Arms / Drug: PROGRESSIVE. Failure pays a proportional partial
//     [0..base] $DIRTY based on how far ETH dropped past the threshold.
//
// So the right efficiency metric is:
//   E[$DIRTY per INF spent] = E[$DIRTY] / E[INF spent]
//                           = E[$DIRTY] / (infCost × P(fail))
//
// As P(fail) → 0 the player loses no INF; the formula returns ∞.
// Renderers must handle that ("∞ / no losses").
//
// The exact partial-reward formula isn't documented. We model it
// with a single per-op constant `failureRewardFraction` =
// E[reward | failure] / base. Defaults to 0.5 for Arms/Drug; 0 for
// Extortion. Override via env vars FAILURE_REWARD_FRACTION_{EXT,
// ARMS,DRUG}.
//
// History: this file used to assume a hardcoded 5 INF per op AND
// ignored the success refund — DIRTY/INF was understated by ~3x for
// high-SR strategies. Fixed 2026-05-10 after on-chain validation.
// ============================================================

export type OpType = 'extortion' | 'arms' | 'drug';

export interface OpEconomics {
  /** Stake at risk per op start (the amount burned at startTrade). */
  influenceCost: number;
  baseReward: number;               // $DIRTY paid on full success
  failureRewardFraction: number;    // E[reward | fail] / baseReward
}

function envFraction(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) return fallback;
  return v;
}

// Default base reward = 100 $DIRTY (Power Level 1). Promote via env
// when the player levels up: BASE_REWARD_DIRTY=115 (PL2) or 130 (PL3+).
const BASE_REWARD_DEFAULT = (() => {
  const raw = process.env.BASE_REWARD_DIRTY;
  if (!raw) return 100;
  const v = parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : 100;
})();

// Fallback INF cost when OpParamsFeed hasn't sampled yet. Historical
// pre-recalibration value. Live cost (~9-12 INF) flows through the
// optional `liveInfCost` parameter on buildEconomics().
const FALLBACK_INF_COST = 5.0;

export const OP_ECONOMICS_DEFAULTS: Record<OpType, OpEconomics> = {
  extortion: {
    influenceCost: FALLBACK_INF_COST,
    baseReward: BASE_REWARD_DEFAULT,
    failureRewardFraction: envFraction('FAILURE_REWARD_FRACTION_EXT', 0.0),
  },
  arms: {
    influenceCost: FALLBACK_INF_COST,
    baseReward: BASE_REWARD_DEFAULT,
    failureRewardFraction: envFraction('FAILURE_REWARD_FRACTION_ARMS', 0.5),
  },
  drug: {
    influenceCost: FALLBACK_INF_COST,
    baseReward: BASE_REWARD_DEFAULT,
    failureRewardFraction: envFraction('FAILURE_REWARD_FRACTION_DRUG', 0.5),
  },
};

// Backwards compat: keep OP_ECONOMICS as an alias since older code
// imports it. Anyone reading this directly gets the fallback values.
// The dashboard-side calc uses buildEconomics() which threads in the
// live cost.
export const OP_ECONOMICS = OP_ECONOMICS_DEFAULTS;

export interface OpEvSnapshot {
  op: OpType;
  probFail: number;          // calibrated P(fail), 0..1
  probSuccess: number;       // 1 - probFail
  evDirty: number;           // expected $DIRTY per op
  /**
   * Expected $DIRTY per INF actually consumed (refund-on-success modeled).
   * Can be `Infinity` when probFail=0 — operator never loses INF, so
   * per-INF earnings is unbounded. Renderers must handle ∞ display.
   */
  dirtyPerInf: number;
  baseReward: number;
  failureRewardFraction: number;
  /** Stake at risk per op (burned at startTrade, may be refunded). */
  influenceCost: number;
  /** E[INF actually spent] = influenceCost × probFail. */
  expectedInfBurned: number;
}

export interface OpEvSnapshotExtended extends OpEvSnapshot {
  failureFractionSource: 'default' | 'empirical';
}

/**
 * Compute expected $DIRTY/op + refund-aware $DIRTY/INF for a single op.
 *
 * Formula (refund-on-success):
 *   E[$DIRTY]      = base × (1 - (1 - failFrac) × P(fail))
 *   E[INF burned]  = influenceCost × P(fail)
 *   E[$DIRTY/INF]  = E[$DIRTY] / E[INF burned]
 *                  = ∞ when P(fail) = 0
 *
 * `liveInfCost` overrides the fallback when provided (typically threaded
 * in from OpParamsFeed.infCostPerOp).
 */
export function computeOpEv(
  op: OpType,
  probFail: number,
  empiricalFailFrac?: number,
  liveInfCost?: number,
): OpEvSnapshotExtended {
  const econ = OP_ECONOMICS_DEFAULTS[op];
  const cost = liveInfCost != null && Number.isFinite(liveInfCost) && liveInfCost > 0
    ? liveInfCost
    : econ.influenceCost;
  const p = Math.max(0, Math.min(1, probFail));
  const failFrac = empiricalFailFrac !== undefined ? empiricalFailFrac : econ.failureRewardFraction;
  const evDirty = econ.baseReward * (1 - (1 - failFrac) * p);
  const expectedInfBurned = cost * p;
  // ∞ when no expected INF burn (perfect-success regime).
  const dirtyPerInf = expectedInfBurned > 0
    ? evDirty / expectedInfBurned
    : (evDirty > 0 ? Infinity : 0);
  return {
    op,
    probFail: p,
    probSuccess: 1 - p,
    evDirty,
    dirtyPerInf,
    baseReward: econ.baseReward,
    failureRewardFraction: failFrac,
    influenceCost: cost,
    expectedInfBurned,
    failureFractionSource: empiricalFailFrac !== undefined ? 'empirical' : 'default',
  };
}

export interface EconomicsBlock {
  baseReward: number;          // current PL base reward used for all calcs
  influenceCost: number;       // live INF cost (from OpParamsFeed) or fallback
  extortion: OpEvSnapshotExtended;
  arms: OpEvSnapshotExtended;
  drug: OpEvSnapshotExtended;
  bestEvPerInfOp: OpType;      // which op has highest E[$DIRTY/INF] right now
  bestEvPerInfValue: number;   // can be Infinity
}

/**
 * Build the full economics block used by the dashboard + daily digest.
 *
 * `liveInfCost` should be the latest OpParamsFeed.infCostPerOp value;
 * pass null/undefined to use the historical 5.0 fallback.
 *
 * `empiricalFractions` is an optional per-op override coming from op-stats.
 * If a key is present, the corresponding op uses the empirical value
 * instead of the env-default.
 */
export function buildEconomics(
  probs: { extortion: number; arms: number; drug: number },
  empiricalFractions: Partial<Record<OpType, number>> = {},
  liveInfCost?: number | null,
): EconomicsBlock {
  const cost = liveInfCost != null && Number.isFinite(liveInfCost) && liveInfCost > 0
    ? liveInfCost
    : FALLBACK_INF_COST;
  const ext  = computeOpEv('extortion', probs.extortion, empiricalFractions.extortion, cost);
  const arms = computeOpEv('arms',      probs.arms,      empiricalFractions.arms,      cost);
  const drug = computeOpEv('drug',      probs.drug,      empiricalFractions.drug,      cost);

  // Pick the highest dirtyPerInf as the recommended op. Infinity ranks
  // strictly above any finite value. If multiple ops share Infinity
  // (all P(fail)=0), pick the one with highest evDirty as tiebreaker.
  const candidates = [ext, arms, drug];
  candidates.sort((a, b) => {
    if (a.dirtyPerInf === b.dirtyPerInf) return b.evDirty - a.evDirty;
    if (!Number.isFinite(a.dirtyPerInf)) return -1;
    if (!Number.isFinite(b.dirtyPerInf)) return 1;
    return b.dirtyPerInf - a.dirtyPerInf;
  });
  const best = candidates[0];

  return {
    baseReward: BASE_REWARD_DEFAULT,
    influenceCost: cost,
    extortion: ext,
    arms,
    drug,
    bestEvPerInfOp: best.op,
    bestEvPerInfValue: best.dirtyPerInf,
  };
}
