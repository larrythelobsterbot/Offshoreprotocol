// ============================================================
// Operation economics — expected $DIRTY per op and per Influence.
//
// The dashboard's raw output is calibrated P(fail) per operation,
// but the *decision* metric a player cares about is expected
// $DIRTY per Influence spent, since Influence is purchased with
// USDM (i.e. the scarce resource).
//
// Per canonical specs (offshoreprotocol.fun/llms.txt):
//   - All ops cost 5 Influence per start.
//   - Influence is NEVER refunded on failure (only on success).
//   - Success pays 100-130 $DIRTY based on Power Level
//     (100 PL1, 115 PL2, 130 PL3+).
//   - Extortion: BINARY. Failure pays 0 $DIRTY.
//   - Arms / Drug: PROGRESSIVE. Failure pays a proportional
//     partial [0..base] $DIRTY based on how far ETH dropped past
//     the threshold.
//
// The exact partial-reward formula isn't documented. We model it
// with a single per-op constant `failureRewardFraction` =
// E[reward | failure] / base. Defaults are reasonable placeholders
// to be tuned once the in-game behavior is observed:
//   Extortion: 0    (binary, doc-confirmed)
//   Arms:      0.50 (placeholder)
//   Drug:      0.50 (placeholder)
//
// Override via env vars FAILURE_REWARD_FRACTION_{EXT,ARMS,DRUG}
// to tune without redeploying.
// ============================================================

export type OpType = 'extortion' | 'arms' | 'drug';

export interface OpEconomics {
  influenceCost: number;            // INF spent per op start
  baseReward: number;               // $DIRTY paid on full success at current PL
  failureRewardFraction: number;    // E[reward | fail] / baseReward, in [0, 1]
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

export const OP_ECONOMICS: Record<OpType, OpEconomics> = {
  extortion: {
    influenceCost: 5,
    baseReward: BASE_REWARD_DEFAULT,
    failureRewardFraction: envFraction('FAILURE_REWARD_FRACTION_EXT', 0.0),
  },
  arms: {
    influenceCost: 5,
    baseReward: BASE_REWARD_DEFAULT,
    failureRewardFraction: envFraction('FAILURE_REWARD_FRACTION_ARMS', 0.5),
  },
  drug: {
    influenceCost: 5,
    baseReward: BASE_REWARD_DEFAULT,
    failureRewardFraction: envFraction('FAILURE_REWARD_FRACTION_DRUG', 0.5),
  },
};

export interface OpEvSnapshot {
  op: OpType;
  probFail: number;          // calibrated P(fail), 0..1
  probSuccess: number;       // 1 - probFail
  evDirty: number;           // expected $DIRTY per op
  dirtyPerInf: number;       // expected $DIRTY per Influence spent
  baseReward: number;        // $DIRTY paid on full success
  failureRewardFraction: number;
}

export interface OpEvSnapshotExtended extends OpEvSnapshot {
  failureFractionSource: 'default' | 'empirical';
}

/**
 * E[$DIRTY per op] = base * (P(succ) + failFrac * P(fail))
 *                  = base * (1 - (1 - failFrac) * P(fail))
 * E[$DIRTY per INF] = E[$DIRTY] / influenceCost
 *
 * If `empiricalFailFrac` is provided (because op-stats has enough samples),
 * it overrides the env default for THIS computation only — leaves OP_ECONOMICS
 * untouched so the source-of-truth distinction is preserved in the snapshot.
 */
export function computeOpEv(
  op: OpType,
  probFail: number,
  empiricalFailFrac?: number,
): OpEvSnapshotExtended {
  const econ = OP_ECONOMICS[op];
  const p = Math.max(0, Math.min(1, probFail));
  const failFrac = empiricalFailFrac !== undefined ? empiricalFailFrac : econ.failureRewardFraction;
  const evDirty = econ.baseReward * (1 - (1 - failFrac) * p);
  const dirtyPerInf = evDirty / econ.influenceCost;
  return {
    op,
    probFail: p,
    probSuccess: 1 - p,
    evDirty,
    dirtyPerInf,
    baseReward: econ.baseReward,
    failureRewardFraction: failFrac,
    failureFractionSource: empiricalFailFrac !== undefined ? 'empirical' : 'default',
  };
}

export interface EconomicsBlock {
  baseReward: number;          // current PL base reward used for all calcs
  influenceCost: number;       // INF cost per op (always 5 currently)
  extortion: OpEvSnapshotExtended;
  arms: OpEvSnapshotExtended;
  drug: OpEvSnapshotExtended;
  bestEvPerInfOp: OpType;      // which op has highest E[$DIRTY/INF] right now
  bestEvPerInfValue: number;
}

/**
 * `empiricalFractions` is an optional per-op override coming from op-stats.
 * If a key is present, the corresponding op uses the empirical value instead
 * of the env-default. Missing keys fall back to OP_ECONOMICS defaults.
 */
export function buildEconomics(
  probs: { extortion: number; arms: number; drug: number },
  empiricalFractions: Partial<Record<OpType, number>> = {},
): EconomicsBlock {
  const ext  = computeOpEv('extortion', probs.extortion, empiricalFractions.extortion);
  const arms = computeOpEv('arms',      probs.arms,      empiricalFractions.arms);
  const drug = computeOpEv('drug',      probs.drug,      empiricalFractions.drug);

  // Pick the highest dirtyPerInf as the recommended op.
  let bestOp: OpType = 'drug';
  let bestVal = drug.dirtyPerInf;
  if (arms.dirtyPerInf > bestVal) { bestOp = 'arms'; bestVal = arms.dirtyPerInf; }
  if (ext.dirtyPerInf > bestVal)  { bestOp = 'extortion'; bestVal = ext.dirtyPerInf; }

  return {
    baseReward: BASE_REWARD_DEFAULT,
    influenceCost: 5,
    extortion: ext,
    arms,
    drug,
    bestEvPerInfOp: bestOp,
    bestEvPerInfValue: bestVal,
  };
}
