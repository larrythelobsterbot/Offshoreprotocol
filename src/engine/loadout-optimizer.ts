// ============================================================
// Loadout Optimizer — given the operator's full inventory and N
// unlocked loadouts, find the allocation that maximises sum of
// projected cycle output (`simulateLoadout().projectedOutputUI`).
//
// Approach: per-category enumeration. Each AssetType (Business,
// Insurance, Accountant, Method, Associates, OpSec) contributes
// independent slots — a Business asset can't conflict with an
// Insurance asset. For each category we enumerate all ways to
// distribute the available items across N loadouts (with empty
// slots when supply < N), then take the cartesian product across
// categories and score each full allocation.
//
// Combinatorics: with ≤4 items per category and ≤2 loadouts,
// per-category permutations stay ≤16. Product across 6 categories
// → at most ~16^6 ≈ 16M but typically far less (most categories
// have 1-2 items). Single-digit ms in practice.
//
// For 3-4 loadouts the brute force grows fast (≤ 5^4 per cat); we
// fall back to a greedy-then-hill-climb path if the brute total
// exceeds MAX_BRUTE_COMBOS.
// ============================================================

import {
  SimAsset,
  simulateLoadout,
  SimulationResult,
  STATUS_BASE_ST,
  type GeneratorBase,
} from './loadout-simulator';

export type AssetType = 'Business' | 'Insurance' | 'Accountant' | 'Method' | 'Associates' | 'OpSec';
export const ASSET_TYPES: AssetType[] = [
  'Business', 'Insurance', 'Accountant', 'Method', 'Associates', 'OpSec',
];

export interface OptimizerItem extends SimAsset {
  itemId: number;
  type: AssetType;
}

export interface OptimizerInput {
  /** All items the operator owns. equipped flag is ignored — we re-allocate everything. */
  items: OptimizerItem[];
  /** How many enterprise loadouts to allocate across. */
  numLoadouts: number;
  /** Operator's current Status level (drives base ST + cleaning bonus). */
  statusLevel: number;
  /**
   * Per-loadout base stats reverse-derived from chain. Required for
   * accurate output projection — without it the simulator understates
   * total cycle output by ~5× because the Enterprise contract adds a
   * non-trivial per-generator constant (status base + level perks)
   * on top of slot sums. Length should be ≥ numLoadouts; if a loadout
   * has no base provided, the simulator falls back to the static
   * status table (which is only correct for unlevelled generators).
   */
  generatorBases?: (GeneratorBase | null)[];
  /** Optional current assignment for delta reporting: arrays of itemIds per loadout (length = numLoadouts). */
  currentAssignment?: (number | null)[][];
}

export interface LoadoutResult {
  loadoutIndex: number;
  loadoutName: string;
  itemIds: (number | null)[];      // length 6, ordered by ASSET_TYPES
  items: (OptimizerItem | null)[]; // matching items
  simulation: SimulationResult;
}

export interface Allocation {
  loadouts: LoadoutResult[];
  combinedOutputUI: number;
  combinedOutputRaw: number;
}

export interface Swap {
  itemId: number;
  itemName: string;
  type: AssetType;
  rarity: number;
  from: string;   // "E1" | "E2" | "unequipped"
  to: string;     // "E1" | "E2" | "unequipped"
}

export interface OptimizerOutput {
  numLoadouts: number;
  statusLevel: number;
  current: Allocation | null;
  optimized: Allocation;
  deltaPct: number | null;
  swaps: Swap[];
  analysis: {
    bottleneck: 'survival' | 'output' | 'balanced';
    discretionUsedAvg: number;
    discretionCap: 70;
    avgPctCycleSurvived: number;
    targetStatHints: string[];
  };
  // Diagnostic — useful when verifying the optimizer didn't fall back
  // unnecessarily, and for "fix me" reports if results look wrong.
  searchMode: 'brute' | 'hillclimb';
  comboCount: number;
}

const MAX_BRUTE_COMBOS = 5_000_000;

function loadoutName(i: number): string { return `E${i + 1}`; }

/**
 * For one category, enumerate all ways to fill N loadout slots from K
 * items. Each result is an array of length N (item or null), with no
 * item appearing twice.
 */
function enumerateCategoryAssignments<T>(items: T[], n: number): (T | null)[][] {
  const out: (T | null)[][] = [];
  const slot: (T | null)[] = new Array(n).fill(null);

  function recur(slotIdx: number, used: Set<number>) {
    if (slotIdx === n) {
      out.push(slot.slice());
      return;
    }
    // Option 1: leave empty
    slot[slotIdx] = null;
    recur(slotIdx + 1, used);
    // Option 2: place each unused item
    for (let i = 0; i < items.length; i++) {
      if (used.has(i)) continue;
      slot[slotIdx] = items[i];
      used.add(i);
      recur(slotIdx + 1, used);
      used.delete(i);
    }
  }
  recur(0, new Set());
  return out;
}

function estimateComboCount(itemsByCat: Map<AssetType, OptimizerItem[]>, n: number): number {
  // Closed-form count of per-category assignments:
  //   sum_{k=0..min(K,n)} P(K, k) × C(n, k)
  //   where K = items in category, k = how many slots we fill, n = loadouts.
  //
  // The total search space across categories is the product. We
  // short-circuit early once the running product exceeds the brute-force
  // budget so we don't pay the cost of estimating the long tail —
  // hill-climb takes over in that case anyway.
  let total = 1;
  for (const t of ASSET_TYPES) {
    const items = itemsByCat.get(t) ?? [];
    const k = items.length;
    let perCat = 0;
    const maxPick = Math.min(k, n);
    for (let pick = 0; pick <= maxPick; pick++) {
      // P(k, pick) = k × (k-1) × ... × (k-pick+1)
      let permsK = 1;
      for (let i = 0; i < pick; i++) permsK *= (k - i);
      // C(n, pick) = n! / (pick! × (n-pick)!)
      let cnk = 1;
      for (let i = 0; i < pick; i++) cnk = (cnk * (n - i)) / (i + 1);
      perCat += permsK * cnk;
      // perCat is monotonically increasing in pick; if it already pushes
      // total above the cap we can bail out without finishing this cat.
      if (total * perCat > MAX_BRUTE_COMBOS) {
        return MAX_BRUTE_COMBOS + 1;
      }
    }
    total *= Math.max(1, perCat);
    if (total > MAX_BRUTE_COMBOS) return total;
  }
  return total;
}

function buildLoadouts(
  assignments: ((OptimizerItem | null)[])[],
  statusLevel: number,
  generatorBases?: (GeneratorBase | null)[],
): Allocation {
  const n = assignments[0]?.length ?? 0;
  const loadouts: LoadoutResult[] = [];
  let totalUI = 0, totalRaw = 0;
  for (let li = 0; li < n; li++) {
    const items: (OptimizerItem | null)[] = [];
    const itemIds: (number | null)[] = [];
    for (const cat of assignments) {
      const it = cat[li] ?? null;
      items.push(it);
      itemIds.push(it ? it.itemId : null);
    }
    const sim = simulateLoadout(items, statusLevel, generatorBases?.[li] ?? undefined);
    totalUI  += sim.projectedOutputUI;
    totalRaw += sim.projectedOutput;
    loadouts.push({
      loadoutIndex: li,
      loadoutName: loadoutName(li),
      itemIds, items,
      simulation: sim,
    });
  }
  return { loadouts, combinedOutputUI: totalUI, combinedOutputRaw: totalRaw };
}

function bruteForceOptimize(
  itemsByCat: Map<AssetType, OptimizerItem[]>,
  statusLevel: number,
  numLoadouts: number,
  generatorBases?: (GeneratorBase | null)[],
): { best: Allocation; comboCount: number } {
  // Per-category list of possible (item|null)[numLoadouts] assignments.
  const perCat: ((OptimizerItem | null)[][])[] = ASSET_TYPES.map((t) => {
    const items = itemsByCat.get(t) ?? [];
    return enumerateCategoryAssignments(items, numLoadouts);
  });
  // Iterate via index counters (cartesian product) — avoids materialising
  // the full product in memory.
  const sizes = perCat.map((a) => a.length);
  const idx = new Array(perCat.length).fill(0);
  let best: Allocation | null = null;
  let comboCount = 0;
  // Pre-allocate the per-loadout simulation buffer so we don't churn GC.
  while (true) {
    const cats = perCat.map((arr, i) => arr[idx[i]]);
    const candidate = buildLoadouts(cats, statusLevel, generatorBases);
    comboCount++;
    if (!best || candidate.combinedOutputUI > best.combinedOutputUI) {
      best = candidate;
    }
    // increment counter
    let k = perCat.length - 1;
    while (k >= 0) {
      idx[k]++;
      if (idx[k] < sizes[k]) break;
      idx[k] = 0; k--;
    }
    if (k < 0) break;
  }
  return { best: best!, comboCount };
}

/**
 * Hill-climbing fallback for huge inventories / many loadouts. Starts
 * with a greedy allocation (sort items by output potential, place into
 * weakest loadout in their category), then tries pairwise swaps and
 * unequipped→equipped substitutions until no improvement.
 */
function hillClimbOptimize(
  itemsByCat: Map<AssetType, OptimizerItem[]>,
  statusLevel: number,
  numLoadouts: number,
  generatorBases?: (GeneratorBase | null)[],
): { best: Allocation; comboCount: number } {
  // Greedy seed: for each category, sort items by "high HP+disc first"
  // (survival usually scarcer), then by output. Distribute round-robin.
  const seed: ((OptimizerItem | null)[])[] = ASSET_TYPES.map((t) => {
    const items = (itemsByCat.get(t) ?? []).slice();
    items.sort((a, b) => {
      const score = (it: OptimizerItem) => it.hp * 4 + it.disc * 3 + it.cr + it.eff * 0.2 + it.bc * 0.5 + it.bm * 0.05;
      return score(b) - score(a);
    });
    const row: (OptimizerItem | null)[] = new Array(numLoadouts).fill(null);
    for (let i = 0; i < Math.min(items.length, numLoadouts); i++) row[i] = items[i];
    return row;
  });

  let best = buildLoadouts(seed, statusLevel, generatorBases);
  let comboCount = 1;
  let improved = true;
  while (improved) {
    improved = false;
    // For each category, try every pair (a,b) of slot positions and swap them
    for (let ci = 0; ci < ASSET_TYPES.length; ci++) {
      const items = itemsByCat.get(ASSET_TYPES[ci]) ?? [];
      // Current per-loadout placement for this cat
      const cur = best.loadouts.map((L) => L.items[ci]);
      // Try every (cur item ↔ pool item) substitution per loadout
      for (let li = 0; li < numLoadouts; li++) {
        for (let pi = -1; pi < items.length; pi++) {
          const candidate = pi < 0 ? null : items[pi];
          if (cur[li]?.itemId === candidate?.itemId) continue;
          // Skip if candidate is currently used in a *different* loadout
          // (we handle moves via the pairwise-swap below).
          if (candidate && cur.some((c, j) => j !== li && c?.itemId === candidate.itemId)) continue;
          const trial = cur.slice();
          trial[li] = candidate;
          const trialAssign = ASSET_TYPES.map((_, idx2) => idx2 === ci ? trial : best.loadouts.map((L) => L.items[idx2]));
          const out = buildLoadouts(trialAssign, statusLevel, generatorBases);
          comboCount++;
          if (out.combinedOutputUI > best.combinedOutputUI + 1e-6) {
            best = out;
            improved = true;
          }
        }
      }
      // Pairwise swap across loadouts (move item from loadout A to B)
      for (let a = 0; a < numLoadouts; a++) {
        for (let b = a + 1; b < numLoadouts; b++) {
          const trial = cur.slice();
          const tmp = trial[a]; trial[a] = trial[b]; trial[b] = tmp;
          const trialAssign = ASSET_TYPES.map((_, idx2) => idx2 === ci ? trial : best.loadouts.map((L) => L.items[idx2]));
          const out = buildLoadouts(trialAssign, statusLevel, generatorBases);
          comboCount++;
          if (out.combinedOutputUI > best.combinedOutputUI + 1e-6) {
            best = out;
            improved = true;
          }
        }
      }
    }
  }
  return { best, comboCount };
}

function buildAllocationFromIds(
  ids: (number | null)[][],
  itemsById: Map<number, OptimizerItem>,
  statusLevel: number,
  generatorBases?: (GeneratorBase | null)[],
): Allocation | null {
  if (!ids || ids.length === 0) return null;
  const cats = ASSET_TYPES.map((_, ci) => {
    return ids.map((row) => {
      const id = row[ci];
      if (id == null) return null;
      return itemsById.get(id) ?? null;
    });
  });
  return buildLoadouts(cats, statusLevel, generatorBases);
}

function computeSwaps(current: Allocation | null, optimized: Allocation): Swap[] {
  if (!current) return [];
  // Map itemId → loadout label in current and optimized. Items absent
  // from a map are treated as "unequipped".
  const curMap = new Map<number, string>();
  for (const L of current.loadouts) {
    for (const it of L.items) if (it) curMap.set(it.itemId, L.loadoutName);
  }
  const optMap = new Map<number, string>();
  for (const L of optimized.loadouts) {
    for (const it of L.items) if (it) optMap.set(it.itemId, L.loadoutName);
  }
  const raw: Swap[] = [];
  const seen = new Set<number>();
  const visit = (id: number, item: OptimizerItem) => {
    if (seen.has(id)) return;
    seen.add(id);
    const from = curMap.get(id) ?? 'unequipped';
    const to   = optMap.get(id) ?? 'unequipped';
    if (from !== to) {
      raw.push({
        itemId: id,
        itemName: item.name ?? `#${id}`,
        type: item.type,
        rarity: item.rarity ?? 0,
        from, to,
      });
    }
  };
  for (const L of optimized.loadouts) for (const it of L.items) if (it) visit(it.itemId, it);
  for (const L of current.loadouts)   for (const it of L.items) if (it) visit(it.itemId, it);

  // Suppress no-op moves between INTERCHANGEABLE items. Two items are
  // interchangeable only when they are the same template + same rarity
  // (which together fully determine the stat block per rarity-multiplier
  // rules). If swap A moves X from L1→L2 and swap B moves Y from L2→L1
  // and X.template/rarity == Y.template/rarity, then in-game these two
  // moves cancel — no need to touch either item. Dropping by name
  // alone (the previous logic) would hide real Common↔Legendary swaps.
  const sig = (s: Swap) => `${s.itemName}|${s.rarity}|${s.type}`;
  const byOppositeRoute = new Map<string, Swap[]>();
  for (const s of raw) {
    const k = `${sig(s)}|${s.from}->${s.to}`;
    if (!byOppositeRoute.has(k)) byOppositeRoute.set(k, []);
    byOppositeRoute.get(k)!.push(s);
  }
  const dropped = new Set<number>();
  for (const s of raw) {
    if (dropped.has(s.itemId)) continue;
    const inverse = byOppositeRoute.get(`${sig(s)}|${s.to}->${s.from}`) ?? [];
    const partner = inverse.find((p) => p.itemId !== s.itemId && !dropped.has(p.itemId));
    if (partner) {
      dropped.add(s.itemId);
      dropped.add(partner.itemId);
    }
  }
  return raw.filter((s) => !dropped.has(s.itemId));
}

function analyseAllocation(alloc: Allocation): OptimizerOutput['analysis'] {
  const discValues = alloc.loadouts.map((L) => L.simulation.stats.disc);
  const discAvg = discValues.length ? discValues.reduce((a, b) => a + b, 0) / discValues.length : 0;
  const survPcts = alloc.loadouts.map((L) => L.simulation.pctCycleSurvived);
  const survAvg = survPcts.length ? survPcts.reduce((a, b) => a + b, 0) / survPcts.length : 0;
  let bottleneck: 'survival' | 'output' | 'balanced' = 'balanced';
  if (survAvg < 70) bottleneck = 'survival';
  else if (survAvg > 95 && discAvg < 50) bottleneck = 'output';

  const hints: string[] = [];
  if (survAvg < 70) {
    const discRoom = 70 - discAvg;
    hints.push(`Survival bottleneck — avg cycle survived ${survAvg.toFixed(0)}%. Buy Insurance (ST) or OpSec/Method (Disc).`);
    if (discRoom > 5) hints.push(`Discretion headroom: ${discRoom.toFixed(0)}pp before the 70% cap. Each +1% Disc cuts suspicion proportionally.`);
  }
  if (bottleneck === 'output') {
    hints.push(`Output bottleneck — loadouts survive full cycle with room to spare. Add CR (Business) or Eff/BC/BM (Associates, Accountant).`);
  }
  if (bottleneck === 'balanced') {
    hints.push(`Allocation is reasonably balanced. Next packs: prioritise rarity upgrades on your weakest cleaning slot.`);
  }

  return {
    bottleneck,
    discretionUsedAvg: discAvg,
    discretionCap: 70,
    avgPctCycleSurvived: survAvg,
    targetStatHints: hints,
  };
}

/**
 * Main entry point. Find the asset allocation that maximises combined
 * cycle output across `numLoadouts` enterprises, and report the diff
 * versus the operator's current assignment.
 */
export function optimizeLoadouts(input: OptimizerInput): OptimizerOutput {
  const { items, numLoadouts, statusLevel, currentAssignment, generatorBases } = input;
  if (numLoadouts < 1) {
    throw new Error('numLoadouts must be ≥1');
  }
  if (!STATUS_BASE_ST[Math.floor(statusLevel)]) {
    // Clamp silently — simulator handles out-of-range, but warn intent.
  }

  // Bucket items by AssetType.
  const itemsByCat = new Map<AssetType, OptimizerItem[]>();
  for (const t of ASSET_TYPES) itemsByCat.set(t, []);
  for (const it of items) {
    if (!ASSET_TYPES.includes(it.type)) continue;
    itemsByCat.get(it.type)!.push(it);
  }
  const itemsById = new Map<number, OptimizerItem>();
  for (const it of items) itemsById.set(it.itemId, it);

  // Decide search strategy.
  const est = estimateComboCount(itemsByCat, numLoadouts);
  const useBrute = est <= MAX_BRUTE_COMBOS;
  const search = useBrute
    ? bruteForceOptimize(itemsByCat, statusLevel, numLoadouts, generatorBases)
    : hillClimbOptimize(itemsByCat, statusLevel, numLoadouts, generatorBases);
  const optimized = search.best;

  const current = currentAssignment
    ? buildAllocationFromIds(currentAssignment, itemsById, statusLevel, generatorBases)
    : null;

  const deltaPct = current && current.combinedOutputUI > 0
    ? ((optimized.combinedOutputUI - current.combinedOutputUI) / current.combinedOutputUI) * 100
    : null;

  return {
    numLoadouts,
    statusLevel,
    current,
    optimized,
    deltaPct,
    swaps: computeSwaps(current, optimized),
    analysis: analyseAllocation(optimized),
    searchMode: useBrute ? 'brute' : 'hillclimb',
    comboCount: search.comboCount,
  };
}
