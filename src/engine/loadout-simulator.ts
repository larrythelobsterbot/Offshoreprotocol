// ============================================================
// Loadout Simulator — pure cycle-output projection for hypothetical
// asset allocations. Reuses the validated basis-points math from
// `feeds/loadout-scanner::computeVaultProjection` (verified ±0.01%
// against the in-game UI; see /tmp/optimize2.py for the reference impl).
//
// Why a separate module: computeVaultProjection() is anchored to a live
// chain cycle and consumes contract-aggregated stats (which already
// include status base ST + level bonus). The optimizer builds
// hypothetical loadouts from raw items, so it needs to compute the
// aggregate itself given a status level.
// ============================================================

// Status → base Suspicion Tolerance (HP). From CLAUDE.md status table.
// Index 0 unused; level 1..10.
export const STATUS_BASE_ST = [0, 60, 73, 86, 100, 113, 126, 140, 153, 166, 188];

// Status → cleaning-bonus % multiplier applied to final cycle output.
// Mirrors the contract's `levelBonus` returned from getAggregateStats().
export const STATUS_CLEANING_BONUS_PCT = [0, 0, 1, 3, 6, 10, 15, 21, 28, 36, 46];

// Simulator constants (basis points where shown). Match the in-game JS
// bundle exactly. See feeds/loadout-scanner.ts:42-48 for the canonical
// values these mirror.
const TOTAL_TICKS  = 900;
const BASE_DAMAGE  = 3333;
const HEAT_COEFF   = 20;
const DISC_CAP_BP  = 7000;    // 70% Discretion cap in basis points
const DAMAGE_SCALE = 10000;

// UI scale: simulator output × 1029 / 1e6 = in-game M-cash. Matches the
// loadout-scanner's anchored value (verified against a live loadout
// scoring 184.63M with simulator output 179,397).
export const UI_SCALE = 1029;

/**
 * Asset slot. Stats are already rarity-multiplied (i.e. these are the
 * effective values, not the template base values). All % stats are in
 * whole-number percent (e.g. eff=147 means 147%).
 */
export interface SimAsset {
  itemId?: number;
  templateId?: number;
  name?: string;
  type?: string;       // Business / Insurance / Accountant / Method / Associates / OpSec
  rarity?: number;
  cr: number;
  hp: number;
  eff: number;
  bc: number;
  bm: number;
  disc: number;
}

export interface LoadoutAggregateStats {
  /** Effective ST after status base. */
  hp: number;
  cr: number;
  eff: number;
  bc: number;
  bm: number;
  disc: number;
  /** Cleaning bonus % from status level (applied as final output multiplier). */
  levelBonus: number;
}

export interface SimulationResult {
  /** Aggregate stats used to drive the simulation. */
  stats: LoadoutAggregateStats;
  /** Ticks the loadout survived before bust (capped at 900). */
  ticksAlive: number;
  /** ticksAlive / 900 × 100. */
  pctCycleSurvived: number;
  /** Per-tick suspicion accrual (after disc + heat). */
  damagePerTick: number;
  /** Per-tick avg cleaning output (CR × eff% × (1 + bc%·bm%)). */
  outputPerTick: number;
  /** Total cleaning cash at end of run, raw units. */
  projectedOutput: number;
  /** Same as projectedOutput but scaled to in-game M-cash UI. */
  projectedOutputUI: number;
  /** Discretion actually applied (capped at 70%). */
  effectiveDisc: number;
  /** True if the loadout simulates out to 900 ticks. */
  willSurvive: boolean;
}

/**
 * Per-generator "base" stats contributed by the Enterprise contract on
 * top of equipped slots. Discovered empirically: chain
 * `getAggregateStats()` returns sums that exceed slot totals by a
 * consistent per-generator offset across slot configurations (e.g. on
 * the operator's E2 the chain reports CR=123 while slot CRs sum to 73 —
 * a constant +50 from the generator itself). Most likely these are
 * status-base ST + Enterprise levelling perks.
 *
 * For accurate hypothetical-loadout simulation we MUST pass each gen's
 * own base — falling back to the static STATUS_BASE_ST table understates
 * output by ~5×.
 */
export interface GeneratorBase {
  hp: number;
  cr: number;
  eff: number;
  bc: number;
  bm: number;
  disc: number;
  levelBonus: number;
}

/**
 * Aggregate a set of (already-rarity-multiplied) assets into a loadout
 * stat block, layered on top of a generator base. If no base is given
 * we fall back to status-table HP + cleaning-bonus (correct for empty
 * Enterprises only; current operator gens require a chain-derived base).
 */
export function aggregateLoadout(
  items: (SimAsset | null | undefined)[],
  statusLevel: number,
  base?: GeneratorBase,
): LoadoutAggregateStats {
  let hp = 0, cr = 0, eff = 0, bc = 0, bm = 0, disc = 0;
  for (const it of items) {
    if (!it) continue;
    hp   += it.hp   || 0;
    cr   += it.cr   || 0;
    eff  += it.eff  || 0;
    bc   += it.bc   || 0;
    bm   += it.bm   || 0;
    disc += it.disc || 0;
  }
  const sl = clampStatus(statusLevel);
  if (base) {
    return {
      hp:   base.hp   + hp,
      cr:   base.cr   + cr,
      eff:  base.eff  + eff,
      bc:   base.bc   + bc,
      bm:   base.bm   + bm,
      disc: base.disc + disc,
      levelBonus: base.levelBonus,
    };
  }
  return {
    hp: hp + STATUS_BASE_ST[sl],
    cr, eff, bc, bm, disc,
    levelBonus: STATUS_CLEANING_BONUS_PCT[sl],
  };
}

/**
 * Reverse-derive a generator's base stats from its on-chain aggregate
 * and the items currently equipped in it. Subtracts slot contributions
 * from the contract aggregate to isolate the per-generator constants
 * (status base + Enterprise upgrade perks). Pass this base back to
 * aggregateLoadout() when simulating hypothetical configs for the same
 * generator.
 */
export function deriveGeneratorBase(
  aggregate: { hp: number; cr: number; eff: number; bc: number; bm: number; disc: number; levelBonus: number },
  equippedItems: (SimAsset | null | undefined)[],
): GeneratorBase {
  let hp = 0, cr = 0, eff = 0, bc = 0, bm = 0, disc = 0;
  for (const it of equippedItems) {
    if (!it) continue;
    hp   += it.hp   || 0;
    cr   += it.cr   || 0;
    eff  += it.eff  || 0;
    bc   += it.bc   || 0;
    bm   += it.bm   || 0;
    disc += it.disc || 0;
  }
  return {
    hp:   aggregate.hp   - hp,
    cr:   aggregate.cr   - cr,
    eff:  aggregate.eff  - eff,
    bc:   aggregate.bc   - bc,
    bm:   aggregate.bm   - bm,
    disc: aggregate.disc - disc,
    levelBonus: aggregate.levelBonus,
  };
}

function clampStatus(n: number): number {
  if (!Number.isFinite(n)) return 1;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > 10) return 10;
  return i;
}

/**
 * Run the 900-tick cycle simulator on a pre-aggregated loadout. This is
 * the kernel of the validated optimizer (matches in-game UI to ±0.01%).
 *
 * Mirrors `computeVaultProjection()` arithmetic; that function adds live
 * wall-clock interpolation on top for the operator dashboard, while this
 * one stays pure for the optimizer.
 */
export function simulateAggregate(stats: LoadoutAggregateStats): SimulationResult {
  // Convert % → basis points where the formula expects them.
  const eff_bp  = Math.round(stats.eff  * 100);
  const bc_bp   = Math.round(stats.bc   * 100);
  const bm_bp   = Math.round(stats.bm   * 100);
  const disc_bp = Math.round(stats.disc * 100);

  // Discretion cap at 70%.
  const u = Math.min(disc_bp, DISC_CAP_BP);
  // Efficiency = 100% when no eff stat present.
  const g = eff_bp > 0 ? eff_bp : 10000;
  // Base output per tick (drives suspicion accrual).
  const d = (stats.cr * g) / 10000;
  // Bonus payout = base × BM (when bonus chance triggers).
  const h_unit = (d * bm_bp) / 10000;
  // Expected (avg) output per tick = base + BC × bonus.
  const m = d + (bc_bp * h_unit) / 10000;
  // Raw suspicion damage scales with expected output (high output =
  // higher heat). HEAT_COEFF=20 in basis points (i.e. 0.2% per unit).
  const b_raw  = (BASE_DAMAGE * (10000 + m * HEAT_COEFF)) / 10000;
  // Discretion reduces suspicion accrual linearly.
  const b_after_disc = (b_raw * (10000 - u)) / 10000;
  // Total damage budget = HP × DAMAGE_SCALE.
  const v = stats.hp * DAMAGE_SCALE;
  const damagePerTick = Math.max(b_after_disc, 1e-9);
  const survivedTicks = stats.hp <= 0 || stats.cr <= 0
    ? 0
    : Math.min(TOTAL_TICKS, Math.ceil(v / damagePerTick));

  // Cleaning math (the displayed cycle output).
  const A = stats.cr * (g / 10000);
  const bonus_rate = (bc_bp / 10000) * (bm_bp / 10000);
  const outputPerTick = A * (1 + bonus_rate);
  const statusBonusMul = 1 + (stats.levelBonus / 100);
  const projectedOutput = outputPerTick * survivedTicks * statusBonusMul;
  const projectedOutputUI = (projectedOutput * UI_SCALE) / 1e6;

  return {
    stats,
    ticksAlive: survivedTicks,
    pctCycleSurvived: (survivedTicks / TOTAL_TICKS) * 100,
    damagePerTick,
    outputPerTick,
    projectedOutput,
    projectedOutputUI,
    effectiveDisc: u / 100,
    willSurvive: survivedTicks >= TOTAL_TICKS,
  };
}

/**
 * Convenience: aggregate items + simulate in one call. Use this from
 * the optimizer's hot loop. Pass `base` to layer the items onto a
 * specific generator's reverse-derived base — without it, results
 * understate true output by ~5× on operator-grade Enterprises.
 *
 * Empty loadouts (no equipped items) are projected as zero output:
 * per game rules, a Swiss Vault loadout only enters the cycle when
 * Assets > 0, so the generator base alone must not score.
 */
export function simulateLoadout(
  items: (SimAsset | null | undefined)[],
  statusLevel: number,
  base?: GeneratorBase,
): SimulationResult {
  const empty = !items.some((it) => it != null);
  const stats = aggregateLoadout(items, statusLevel, base);
  if (empty) {
    return {
      stats,
      ticksAlive: 0,
      pctCycleSurvived: 0,
      damagePerTick: 0,
      outputPerTick: 0,
      projectedOutput: 0,
      projectedOutputUI: 0,
      effectiveDisc: Math.min(stats.disc, 70),
      willSurvive: false,
    };
  }
  return simulateAggregate(stats);
}

export const SIM_CONSTANTS = {
  TOTAL_TICKS, BASE_DAMAGE, HEAT_COEFF, DISC_CAP_BP, DAMAGE_SCALE, UI_SCALE,
};
