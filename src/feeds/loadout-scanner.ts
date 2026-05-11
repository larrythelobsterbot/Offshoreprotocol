// ============================================================
// Loadout Scanner.
//
// Pulls Enterprise loadout data from generatorManager:
//   • Operator's own loadouts + inventory  (every 60s — cheap)
//   • Top-N players' loadouts                (every 15 min)
//   • Network-wide asset popularity tally    (every 15 min)
//
// All reads are batched via Multicall3 to keep RPC pressure low.
//
// Contract: 0x1b5AB7c503C2B1D94e7C42b212b4F944F7c77fce  (generatorManager)
//   getUserGenerators(address) → uint256[]
//   getEquippedItems(uint256 generatorId) → uint256[6]
//   getAggregateStats(uint256 generatorId) → (uint256 hp, cr, eff, bc, bm, disc, levelBonus)
//   getInventory(address) → uint256[]
//   getItem(uint256 itemId) → (uint256 templateId, uint8 rarity, address owner)
//   getTemplate(uint256 templateId) → (uint8 itemType, uint16 cr, hp, eff, bc, bm, disc, bool active)
//   getUserProfile(address) → (uint8 level, uint32 xp, bool initialized)
//
// The 43+1 templates (43 documented + 1 starter Business CR=1) are fetched once
// at startup and cached for the process lifetime.
// ============================================================

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { logger } from '../logger';
import { walletLogTag } from '../utils/wallet-log';

const RPC = 'https://mainnet.megaeth.com/rpc';
const GEN_MGR      = '0x1b5AB7c503C2B1D94e7C42b212b4F944F7c77fce';
const MULTICALL3   = '0xca11bde05977b3631167028862be2a173976ca11';
const USER_FACTORY = '0x619814a203ca441611cee02abf31986ca265dd35';
const TOKEN_INF    = '0x403de0893f0bc66139592ba2fd254672f2db933a';
const TOKEN_DIRTY  = '0xc2f34f8849a8607fd73e06d6849bda07c2b7de38';
const TOKEN_USDM   = '0xfafddbb3fc7688494971a79cc65dca3ef82079e7';
const CYCLE_REWARDS = '0x8C73Cd3BB0bFB577D4578bB075640C1eCc5027c8';
const MODE_NAMES_ABBREV = ['Extortion', 'Arms', 'Drug'] as const;

// Vault simulation constants — single source of truth in engine/vault-constants.
// Local aliases (VAULT_DISC_CAP) preserve existing call-site readability.
import {
  VAULT_TOTAL_TICKS,
  VAULT_BASE_DAMAGE,
  VAULT_HEAT_COEFF,
  VAULT_DISC_CAP_BP as VAULT_DISC_CAP,
  VAULT_DAMAGE_SCALE,
  VAULT_CYCLE_SECONDS,
  VAULT_UI_SCALE,
} from '../engine/vault-constants';
const ITEM_TYPES = ['?', 'Business', 'Insurance', 'Accountant', 'Method', 'Associates', 'OpSec'];
const RARITY_NAMES = ['?', 'Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];
const RARITY_MULT  = [1, 1, 1.5, 2.5, 4.5, 8];

const GEN_MGR_ABI = [
  'function getUserGenerators(address) view returns (uint256[])',
  'function getEquippedItems(uint256) view returns (uint256[6])',
  'function getAggregateStats(uint256) view returns (uint256 hp, uint256 cr, uint256 eff, uint256 bc, uint256 bm, uint256 disc, uint256 levelBonus)',
  'function getInventory(address) view returns (uint256[])',
  'function getItem(uint256) view returns (tuple(uint256 templateId, uint8 rarity, address owner))',
  'function getTemplate(uint256) view returns (tuple(uint8 itemType, uint16 cr, uint16 hp, uint16 eff, uint16 bc, uint16 bm, uint16 disc, bool active))',
  'function getUserProfile(address) view returns (tuple(uint8 level, uint32 xp, bool initialized))',
];

const MC3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[]) external view returns ((bool success, bytes returnData)[])',
];

const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
];
const FACTORY_ABI = [
  'function getUserCompanies(address) view returns (address[])',
];
const CORP_ABI = [
  'function autoTradeEnabled() view returns (bool)',
  'function autoTradeMode() view returns (uint8)',
  'function isTradeActive() view returns (bool)',
  'function tradeStartTime() view returns (uint256)',
  'function pendingReward() view returns (uint256)',
  'function locationId() view returns (uint8)',
  'function getTradeInfo() view returns (bool active, uint8 mode, uint256 entryPrice, uint256 liqPrice, uint256 startTime, uint256 endTime, uint256 influence, uint256 pending, uint256 pendingInf)',
];

// Asset name table (templateId → name) derived by stat-matching the docs roster.
// Built lazily after templates are fetched.
const TEMPLATE_NAMES: Record<number, string> = {};

// Hardcoded mapping derived from stat-fingerprint + docs cross-reference.
// Sourced from llms.txt asset list and confirmed against on-chain template stats.
const NAME_BY_STATS: Record<string, string> = {
  // Format: type|cr|hp|eff%|disc%|bc%|bm% (everything in % whole numbers)
  // Business
  'Business|12|0|8|0|0|0':    'Casino',
  'Business|0|0|0|0|6|35':    'Laser Tag',
  'Business|10|0|0|5|0|0':    'Laundromat',
  'Business|8|4|5|4|0|0':     'Peptide Synthesis Company',
  'Business|14|0|8|0|0|0':    'OpenSea Washtrading Gallery',
  'Business|9|0|12|0|0|0':    'Crypto Exchange',
  'Business|8|0|10|2|0|0':    'Memecoin Launchpad',
  'Business|1|0|0|0|0|0':     'Starter Business', // undocumented template 44
  // Insurance
  'Insurance|0|17|0|0|0|0':   'Diplomatic Immunity',
  'Insurance|0|0|0|7|0|0':    'Friendly Drainer Contract',
  'Insurance|0|11|0|3|0|0':   'Political Protection',
  'Insurance|0|10|9|0|0|0':   'Bail Bonds',
  'Insurance|0|7|6|3|0|0':    'Celsius Withdrawal Pause',
  'Insurance|0|6|0|0|5|18':   'Blackmail Material',
  'Insurance|6|6|5|2|0|0':    "SBF's Parents",
  // Accountant
  'Accountant|6|4|5|5|0|0':   "Caroline's Spreadsheet Guy",
  'Accountant|7|0|0|0|6|20':  'Three Arrows Liquidator',
  'Accountant|10|0|0|5|0|0':  'Shell Company Expert',
  'Accountant|9|7|6|0|0|0':   'Forensic Accountant',
  'Accountant|8|0|8|3|0|0':   'Tether Reserve Auditor',
  'Accountant|0|10|0|4|0|0':  'Compliance Officer',
  'Accountant|0|0|10|0|5|15': 'Coinbase Customer Support',
  // Method
  'Method|0|0|0|6|0|0':       'Tornado Mixer',
  'Method|10|7|0|0|0|0':      'Perp-DEX Points Farming',
  'Method|0|8|0|0|0|25':      'Real Estate Flip',
  'Method|0|0|0|0|7|28':      'Memecoin Washtrading',
  'Method|7|0|8|2|0|0':       'Luna-UST Depeg Arbitrage',
  'Method|8|0|0|4|0|0':       'IRS Mogging',
  'Method|6|0|12|0|0|0':      'WoW Gold Laundering',
  'Method|5|3|7|3|0|0':       'Loan Schemes',
  // Associates
  'Associates|0|0|12|0|7|0':  'ETH Foundation',
  'Associates|0|0|7|0|6|20':  'Wintermute',
  'Associates|0|0|0|0|8|30':  'Trump',
  'Associates|8|0|12|0|0|0':  "Anthropic's Intern",
  'Associates|7|6|0|4|0|0':   'ZachXBT',
  'Associates|6|0|14|0|0|0':  'Tech Billionaires',
  'Associates|0|0|0|2|6|22':  "CZ's Compliance Team",
  // OpSec
  'OpSec|0|14|0|0|0|0':       'Secure Vault',
  'OpSec|0|0|0|7|0|0':        'Encrypted Comms',
  'OpSec|0|6|0|3|0|24':       'Data Haven',
  'OpSec|0|0|0|4|7|16':       'Montenegro Safehouse',
  'OpSec|0|8|0|4|0|0':        'Ledger Recovery Seed',
  'OpSec|7|0|9|2|0|0':        "Alex Mashinsky's Phone",
  'OpSec|5|4|6|5|0|0':        'Shielded Transactions',
};

export interface AssetTemplate {
  templateId: number;
  type: string;       // Business / Insurance / etc
  itemType: number;   // 1..6
  name: string;
  cr: number;  hp: number;  eff: number;     // raw % (already divided)
  bc: number;  bm: number;  disc: number;
}

export interface EquippedSlot {
  category: string;             // Business, Insurance, ...
  itemId: number;
  templateId: number;
  rarity: number;               // 1..5
  rarityName: string;           // 'Common' / 'Rare' / ...
  rarityMult: number;           // 1 / 1.5 / 2.5 / 4.5 / 8
  name: string;
  // Effective stats (after rarity multiplier)
  cr: number;  hp: number;  eff: number;
  bc: number;  bm: number;  disc: number;
}

export interface GeneratorView {
  id: number;
  // Aggregate stats from contract (normalized to %)
  hp: number; cr: number; eff: number; bc: number; bm: number; disc: number;
  levelBonus: number;
  // Per-slot details (length 6, ordered by item type 1..6)
  slots: (EquippedSlot | null)[];
  // Live Vault projection — populated only for the operator's own loadouts
  // when cycle metadata is available. See computeVaultProjection() for math.
  vaultProjection?: VaultProjection | null;
}

/**
 * Per-loadout cycle projection — computed forward from the validated 900-tick
 * simulator using the loadout's current aggregate stats. Anchored to the live
 * cycle's start timestamp from CycleRewards.getCycle(currentCycleId).
 *
 * The simulator matches the in-game UI to ±0.01% (verified). Suspicion and
 * cleaning are linear in tick count, so we can interpolate to "right now" and
 * project final state without integrating per-tick.
 */
export interface VaultProjection {
  // Wall-clock anchors
  cycleId: number;
  cycleStartTs: number;     // unix sec
  cycleEndTs: number;       // = cycleStartTs + 8h
  ticksElapsed: number;     // 0..900, derived from elapsed wall-clock
  ticksRemaining: number;
  progressPct: number;      // 0..100

  // Predicted run length (from simulator)
  willSurvive: boolean;     // true if predicted ticks survived ≥ totalTicks
  predictedSurvivalTicks: number;  // simulator's ticks-survived
  predictedSurvivalPct: number;    // 0..100

  // Live state (linear interpolation up to now)
  currentSuspicionPct: number;     // 0..100 (>100 = liquidated)
  currentCleaning: number;         // accumulated cleaning so far (raw units)

  // Final projection (if cycle plays out)
  projectedOutput: number;         // total cleaning at end (raw units)
  projectedOutputUI: number;       // total in M-cash UI units (multiplier baked in)

  // Alert tier (matches op headroom convention)
  alertLevel: 'safe' | 'warn' | 'danger';  // green / yellow / red
}

/** Cycle metadata read from CycleRewards.getCycle(currentCycleId). */
export interface VaultCycle {
  cycleId: number;
  status: number;            // contract status field
  pool: number;              // raw pool size, USDm (1e18 → human)
  netPool: number;           // pool minus protocol fee
  claimed: number;
  startTs: number;           // unix sec — anchor for tick math
  endTs: number;             // startTs + 8h
  secondsElapsed: number;
  secondsRemaining: number;
}

export interface InventoryItem {
  itemId: number;
  templateId: number;
  rarity: number;
  rarityName: string;
  rarityMult: number;
  name: string;
  type: string;
  // Effective stats
  cr: number;  hp: number;  eff: number;
  bc: number;  bm: number;  disc: number;
  // True if this item is currently equipped in any of the user's generators
  equipped: boolean;
}

export interface NetworkAssetStat {
  templateId: number;
  name: string;
  type: string;
  total: number;
  byRarity: number[];   // index 1..5 (5-element array, Common→Mythic)
}

/** Per-corp current operating state (used to surface what whales are running). */
export interface CorpOpView {
  address: string;             // corp contract address
  locationId: number;          // 0..8 for regions
  autoEnabled: boolean;
  mode: number;                // 0/1/2 - current/last trade mode
  modeName: string;            // 'Extortion'/'Arms'/'Drug'
  active: boolean;             // currently mid-trade?
  tradeStartTs: number;        // unix seconds (0 if no active trade)
  tradeEndTs: number;          // unix seconds (when current trade auto-completes)
  influence: number;           // INF staked
  pendingDirty: number;        // unclaimed DIRTY waiting
}

export interface TopPlayerView {
  address: string;
  rank: number;
  // Primary ranking metric (since 2026-05-09): cumulative USDM claimed
  // from CycleRewards in the last `claimRankWindowMs` (default 7 days).
  // Reflects who's actually winning the laundering meta vs just grinding ops.
  claimUsdm7d: number;
  claimsCount7d: number;
  // Secondary metrics (kept for context / fallback ranking)
  opsCount: number;
  dirtyEarned: number;
  // Which metric drove the current rank — useful when claim data is
  // sparse and we fell back to ops-based ranking on startup.
  rankMetric: 'claim_usdm' | 'ops_count';
  generators: GeneratorView[];
  // Tier 2 additions: balances + corp activity
  balances: {
    inf: number;
    dirty: number;
    usdm: number;
  } | null;
  corpCount: number;            // total deployed corps (PL2 = 6, PL3 = 9)
  corps: CorpOpView[];          // current op state for each corp
}

export interface LoadoutBlock {
  // Operator's own state
  user: {
    address: string;
    statusLevel: number;
    statusXp: number;
    statusXpNext?: number;
    generators: GeneratorView[];
    inventory: InventoryItem[];
    inventoryCount: number;
  } | null;

  // Network-wide aggregate
  network: {
    totalLoadouts: number;
    topEquipped: NetworkAssetStat[];           // Top N by total equipped
    topByCategory: Record<string, NetworkAssetStat[]>;
    topLegendaries: NetworkAssetStat[];        // Across all categories, rarity=4
    lastScanTs: number;
  } | null;

  topPlayers: TopPlayerView[];
  templatesAvailable: number;
  // Current Swiss Vault cycle metadata. Refreshed every cycle poll.
  cycle: VaultCycle | null;
  // Lightweight TOP-SR leaderboard. Ranked by win rate with a minimum
  // ops threshold so 1-op-100%-SR wallets don't dominate. Only address
  // + outcome counts are published (no loadout fetch — too expensive
  // for ~25 entries that change every 15min poll). Operator can
  // cross-reference to whale-watch panel for loadout details.
  topBySr?: TopBySrEntry[];
}

export interface TopBySrEntry {
  address: string;
  rank: number;          // 1-based rank by SR
  wins: number;
  losses: number;
  opsCount: number;      // wins + losses
  successRate: number;   // 0..1
  dirtyEarned: number;
  // Helpful cross-references when shown in the panel
  claimUsdm: number;     // 0 if not in the recent claim window
}

/**
 * Pure function: given a loadout's aggregate stats + cycle anchors + status
 * bonus, compute the live projection. Mirrors /tmp/optimize4.py exactly.
 *
 * Inputs are the loadout's CONTRACT-aggregated stats (which already include
 * the generator base + items + status level bonus). The contract returns:
 *   hp, cr (raw uint), eff, bc, bm, disc (basis points × 100, i.e. 12000 = 120%)
 * but the API returns them already normalized to %, so we accept % and
 * convert to bp internally.
 */
export function computeVaultProjection(
  gen: { hp: number; cr: number; eff: number; bc: number; bm: number; disc: number; levelBonus: number },
  cycle: VaultCycle | null,
  nowSec: number,
): VaultProjection | null {
  if (!cycle) return null;
  if (gen.cr <= 0 || gen.hp <= 0) return null;

  // Convert % → basis points where the simulator expects them.
  const cr     = gen.cr;        // raw cleaning rate (units)
  const hp     = gen.hp;        // raw HP
  const eff_bp = Math.round(gen.eff  * 100);
  const bc_bp  = Math.round(gen.bc   * 100);
  const bm_bp  = Math.round(gen.bm   * 100);
  const disc_bp = Math.round(gen.disc * 100);

  // === SIMULATOR (matches in-game formula to ±0.01%) ===
  const u = Math.min(disc_bp, VAULT_DISC_CAP);
  const g = eff_bp > 0 ? eff_bp : 10000;
  const d = (cr * g) / 10000;
  const h_unit = (d * bm_bp) / 10000;
  const m = d + (bc_bp * h_unit) / 10000;
  const b_raw = (VAULT_BASE_DAMAGE * (10000 + m * VAULT_HEAT_COEFF)) / 10000;
  const b_after_disc = (b_raw * (10000 - u)) / 10000;
  const v = hp * VAULT_DAMAGE_SCALE;
  const survivedTicks = Math.min(VAULT_TOTAL_TICKS, Math.ceil(v / Math.max(b_after_disc, 1e-6)));
  const A = cr * (g / 10000);
  const bonus_rate = (bc_bp / 10000) * (bm_bp / 10000);
  const outputPerTick = A * (1 + bonus_rate);
  const statusBonusMul = 1 + (gen.levelBonus / 100);
  const projectedOutput = outputPerTick * survivedTicks * statusBonusMul;
  const projectedOutputUI = (projectedOutput * VAULT_UI_SCALE) / 1e6;

  // === LIVE STATE — interpolate to now ===
  const elapsed = Math.max(0, nowSec - cycle.startTs);
  const progressFraction = Math.min(1, elapsed / VAULT_CYCLE_SECONDS);
  const ticksElapsed = Math.floor(progressFraction * VAULT_TOTAL_TICKS);
  const ticksRemaining = VAULT_TOTAL_TICKS - ticksElapsed;

  // Suspicion = accumulated damage / hp. Past survivedTicks the loadout has
  // simulated-out (capped at 100% so the UI doesn't show >100).
  const damageAccumulated = b_after_disc * Math.min(ticksElapsed, survivedTicks);
  const currentSuspicionPct = Math.min(100, (damageAccumulated / v) * 100);
  // Cleaning is also linear up to survivedTicks.
  const cleaningTicks = Math.min(ticksElapsed, survivedTicks);
  const currentCleaning = outputPerTick * cleaningTicks * statusBonusMul;

  const willSurvive = survivedTicks >= VAULT_TOTAL_TICKS;
  const predictedSurvivalPct = (survivedTicks / VAULT_TOTAL_TICKS) * 100;

  // Alert: danger when current suspicion is high AND cycle still has time
  // left. A loadout that "willSurvive" but is currently at 70% suspicion is
  // OK (it's on track); a loadout at 70% with simulated survival of only
  // 80% is in real danger of getting busted before cycle end.
  let alertLevel: VaultProjection['alertLevel'] = 'safe';
  if (!willSurvive && ticksElapsed >= survivedTicks) alertLevel = 'danger';
  else if (!willSurvive && currentSuspicionPct >= 70) alertLevel = 'danger';
  else if (currentSuspicionPct >= 50) alertLevel = 'warn';

  return {
    cycleId: cycle.cycleId,
    cycleStartTs: cycle.startTs,
    cycleEndTs: cycle.endTs,
    ticksElapsed,
    ticksRemaining,
    progressPct: progressFraction * 100,
    willSurvive,
    predictedSurvivalTicks: survivedTicks,
    predictedSurvivalPct,
    currentSuspicionPct,
    currentCleaning,
    projectedOutput,
    projectedOutputUI,
    alertLevel,
  };
}

interface LoadoutScannerConfig {
  walletAddress: string;
  // How often to refresh the operator's own loadouts (default 60s)
  selfPollMs?: number;
  // How often to re-scan the full network meta + top players (default 15 min)
  networkPollMs?: number;
  // How many players to scan in detail for the "top players" view (default 5)
  topPlayerCount?: number;
  // Lookback for the network ranking event scan (default 100k blocks ≈ 28h)
  rankingLookbackBlocks?: number;
  // Storage handle for claim-based ranking (preferred over ops-based).
  // When provided, ranking uses summed USDM claimed in last 7d as the
  // primary metric; falls back to ops-based ranking if claim data is
  // sparse (< MIN_CLAIMERS_FOR_RANK distinct claimers).
  storage?: import('../storage/db').Storage | null;
  // Window for claim-based ranking. Default 7 days.
  claimRankWindowMs?: number;
}

// TradeCompleted event topic hash (used for the network-wide player ranking)
const TC_TOPIC = '0x35c06e2c02cc93628588ec67d74925fa30de5c693ea264ec67458bb0b65c3bf1';
const TL_TOPIC = '0xbc95a830b1019b9734680ca35152c5632ef54d080bfa3a55531b755867397678';

export class LoadoutScannerFeed extends EventEmitter {
  private cfg: LoadoutScannerConfig;
  private provider: ethers.JsonRpcProvider;
  private mc: ethers.Contract;
  private genIface: ethers.Interface;

  private templates: Map<number, AssetTemplate> = new Map();
  private latest: LoadoutBlock = { user: null, network: null, topPlayers: [], templatesAvailable: 0, cycle: null };
  // Pre-built interfaces for the additional contracts we now query.
  private tokenIface  = new ethers.Interface(TOKEN_ABI);
  private factoryIface = new ethers.Interface(FACTORY_ABI);
  private corpIface   = new ethers.Interface(CORP_ABI);

  private selfTimer: ReturnType<typeof setInterval> | null = null;
  private netTimer:  ReturnType<typeof setInterval> | null = null;
  private alive = false;

  constructor(cfg: LoadoutScannerConfig) {
    super();
    this.cfg = {
      ...cfg,
      selfPollMs:    cfg.selfPollMs    ?? 60_000,
      networkPollMs: cfg.networkPollMs ?? 15 * 60_000,
      topPlayerCount: cfg.topPlayerCount ?? 5,
    };
    this.provider = new ethers.JsonRpcProvider(RPC);
    this.mc       = new ethers.Contract(MULTICALL3, MC3_ABI, this.provider);
    this.genIface = new ethers.Interface(GEN_MGR_ABI);
  }

  getSnapshot(): LoadoutBlock { return this.latest; }

  async start() {
    if (this.alive) return;
    this.alive = true;
    try {
      await this.fetchAllTemplates();
    } catch (err: any) {
      logger.warn({ err: err.message }, '[LoadoutScanner] template prefetch failed; continuing');
    }

    // Kick off both pollers immediately, then on schedule
    void this.refreshSelf();
    void this.refreshNetwork();

    this.selfTimer = setInterval(() => { void this.refreshSelf(); },    this.cfg.selfPollMs!);
    this.netTimer  = setInterval(() => { void this.refreshNetwork(); }, this.cfg.networkPollMs!);
    logger.info({ selfPoll: this.cfg.selfPollMs, netPoll: this.cfg.networkPollMs },
      '[LoadoutScanner] started');
  }

  stop() {
    if (this.selfTimer) clearInterval(this.selfTimer);
    if (this.netTimer)  clearInterval(this.netTimer);
    this.alive = false;
  }

  // ---------- Template prefetch ----------

  private async fetchAllTemplates() {
    // Probe templates 1..60 — anything inactive returns zero itemType
    const calls = [];
    for (let tid = 1; tid <= 60; tid++) {
      calls.push({
        target: GEN_MGR,
        allowFailure: true,
        callData: this.genIface.encodeFunctionData('getTemplate', [tid]),
      });
    }
    const results = await this.mc.aggregate3.staticCall(calls);
    let count = 0;
    for (let i = 0; i < results.length; i++) {
      const tid = i + 1;
      const r = results[i];
      if (!r.success || r.returnData === '0x') continue;
      try {
        const decoded = this.genIface.decodeFunctionResult('getTemplate', r.returnData)[0];
        const itemType = Number(decoded.itemType);
        if (itemType === 0) continue;
        const cr   = Number(decoded.cr);
        const hp   = Number(decoded.hp);
        const eff  = Number(decoded.eff)  / 100;
        const bc   = Number(decoded.bc)   / 100;
        const bm   = Number(decoded.bm)   / 100;
        const disc = Number(decoded.disc) / 100;
        const type = ITEM_TYPES[itemType] ?? '?';
        const key = `${type}|${cr}|${hp}|${eff}|${disc}|${bc}|${bm}`;
        const name = NAME_BY_STATS[key] ?? `Template ${tid}`;
        this.templates.set(tid, {
          templateId: tid, type, itemType, name,
          cr, hp, eff, bc, bm, disc,
        });
        TEMPLATE_NAMES[tid] = name;
        count++;
      } catch { /* skip bad decode */ }
    }
    this.latest.templatesAvailable = count;
    logger.info({ count }, '[LoadoutScanner] template registry built');
  }

  // ---------- Helpers ----------

  /** Decode an item via getItem + look up its template. Returns null if unresolvable. */
  private resolveItem(itemId: number, info: { templateId: number; rarity: number }):
      Omit<EquippedSlot, 'category'> | null {
    if (itemId === 0) return null;
    const tpl = this.templates.get(info.templateId);
    if (!tpl) return null;
    const m = RARITY_MULT[info.rarity] ?? 1;
    return {
      itemId,
      templateId: info.templateId,
      rarity: info.rarity,
      rarityName: RARITY_NAMES[info.rarity] ?? '?',
      rarityMult: m,
      name: tpl.name,
      cr:   tpl.cr   * m,
      hp:   tpl.hp   * m,
      eff:  tpl.eff  * m,
      bc:   tpl.bc   * m,
      bm:   tpl.bm   * m,
      disc: tpl.disc * m,
    };
  }

  /** Fetch user's loadouts + inventory. Cheap (one user × few generators). */
  /**
   * Read the active Swiss Vault cycle metadata. Cycles last 8h, so this is
   * cheap to call every poll (one eth_call to currentCycleId, one to
   * getCycle). Caller can decide cadence; we call it on every refreshSelf.
   *
   * Returns null if the contract is unreachable. Updates this.latest.cycle.
   */
  private async refreshCycle() {
    try {
      // currentCycleId() selector = 0xaaacdda0
      const cidHex = await this.provider.call({ to: CYCLE_REWARDS, data: '0xaaacdda0' });
      if (!cidHex || cidHex === '0x') return;
      const cycleId = Number(BigInt(cidHex));
      if (cycleId <= 0) return;

      // getCycle(uint256) selector = 0x2026f638
      const cidArg = '0x2026f638' + cycleId.toString(16).padStart(64, '0');
      const data = await this.provider.call({ to: CYCLE_REWARDS, data: cidArg });
      if (!data || data === '0x') return;
      const x = data.replace(/^0x/, '');
      // Layout (verified by probing cycles 1..6):
      //   w0: status (uint8 in u256), w1: pool, w2: netPool, w3: claimed,
      //   w4: startTime, w5/w6: merkle roots (ignored)
      const status   = Number(BigInt('0x' + x.slice(0, 64)));
      const pool     = Number(BigInt('0x' + x.slice(64, 128))) / 1e18;
      const netPool  = Number(BigInt('0x' + x.slice(128, 192))) / 1e18;
      const claimed  = Number(BigInt('0x' + x.slice(192, 256))) / 1e18;
      const startTs  = Number(BigInt('0x' + x.slice(256, 320)));
      const endTs    = startTs + VAULT_CYCLE_SECONDS;
      const nowSec   = Math.floor(Date.now() / 1000);

      this.latest.cycle = {
        cycleId,
        status, pool, netPool, claimed,
        startTs, endTs,
        secondsElapsed:   Math.max(0, nowSec - startTs),
        secondsRemaining: Math.max(0, endTs - nowSec),
      };
    } catch (err: any) {
      logger.warn({ err: err.message }, '[LoadoutScanner] refreshCycle failed');
    }
  }

  /**
   * Fetch a wallet's full loadout view (status profile + generators with
   * vault projection + inventory). Public so the multi-wallet tracker can
   * reuse the same chain-read logic without duplicating multicall wiring.
   *
   * Returns null if the wallet has no generators or the chain reads fail.
   * Does NOT mutate this.latest — callers manage their own caching.
   *
   * Cycle metadata is read from this.latest.cycle (refreshed on every
   * refreshSelf cycle), so projections are anchored to the freshest cycle.
   */
  async fetchUserView(addr: string): Promise<LoadoutBlock['user']> {
    if (!addr || addr.length !== 42) return null;
    try {
      // Step A: get generators + status profile + inventory in one batch
      const a1 = [
        { target: GEN_MGR, allowFailure: true,
          callData: this.genIface.encodeFunctionData('getUserGenerators', [addr]) },
        { target: GEN_MGR, allowFailure: true,
          callData: this.genIface.encodeFunctionData('getUserProfile',    [addr]) },
        { target: GEN_MGR, allowFailure: true,
          callData: this.genIface.encodeFunctionData('getInventory',      [addr]) },
      ];
      const r1 = await this.mc.aggregate3.staticCall(a1);
      if (!r1[0].success || !r1[2].success) return null;

      const gens = this.genIface.decodeFunctionResult('getUserGenerators', r1[0].returnData)[0]
        .map((x: bigint) => Number(x));
      const profile = r1[1].success
        ? this.genIface.decodeFunctionResult('getUserProfile', r1[1].returnData)[0]
        : { level: 0, xp: 0 };
      const invItemIds = this.genIface.decodeFunctionResult('getInventory', r1[2].returnData)[0]
        .map((x: bigint) => Number(x));

      // Step B: per-generator (equipped items + aggregate stats)
      const a2: any[] = [];
      for (const g of gens) {
        a2.push({ target: GEN_MGR, allowFailure: true,
          callData: this.genIface.encodeFunctionData('getEquippedItems', [g]) });
        a2.push({ target: GEN_MGR, allowFailure: true,
          callData: this.genIface.encodeFunctionData('getAggregateStats', [g]) });
      }
      const r2 = a2.length ? await this.mc.aggregate3.staticCall(a2) : [];

      // Collect all equipped + inventory item IDs to resolve in one batch
      const allItemIds = new Set<number>(invItemIds);
      const equippedByGen: Record<number, number[]> = {};
      for (let i = 0; i < gens.length; i++) {
        const eqRes = r2[i*2];
        if (eqRes && eqRes.success) {
          const slots = this.genIface.decodeFunctionResult('getEquippedItems', eqRes.returnData)[0];
          equippedByGen[gens[i]] = slots.map((x: bigint) => Number(x));
          for (const id of equippedByGen[gens[i]]) if (id > 0) allItemIds.add(id);
        } else {
          equippedByGen[gens[i]] = [0,0,0,0,0,0];
        }
      }

      // Step C: resolve each item id (templateId + rarity)
      const idList = Array.from(allItemIds).filter(x => x > 0);
      const a3 = idList.map(id => ({
        target: GEN_MGR, allowFailure: true,
        callData: this.genIface.encodeFunctionData('getItem', [id]),
      }));
      const r3 = a3.length ? await this.mc.aggregate3.staticCall(a3) : [];
      const itemMeta = new Map<number, { templateId: number; rarity: number }>();
      for (let i = 0; i < idList.length; i++) {
        const res = r3[i];
        if (!res || !res.success) continue;
        try {
          const dec = this.genIface.decodeFunctionResult('getItem', res.returnData)[0];
          itemMeta.set(idList[i], {
            templateId: Number(dec.templateId),
            rarity:     Number(dec.rarity),
          });
        } catch { /* skip */ }
      }

      // Build generator views
      const equippedSet = new Set<number>();
      const generators: GeneratorView[] = [];
      for (let i = 0; i < gens.length; i++) {
        const g = gens[i];
        const stats = r2[i*2 + 1];
        let agg = { hp:0, cr:0, eff:0, bc:0, bm:0, disc:0, levelBonus:0 };
        if (stats && stats.success) {
          try {
            const d = this.genIface.decodeFunctionResult('getAggregateStats', stats.returnData);
            agg = {
              hp:         Number(d[0]),
              cr:         Number(d[1]),
              eff:        Number(d[2]) / 100,
              bc:         Number(d[3]) / 100,
              bm:         Number(d[4]) / 100,
              disc:       Number(d[5]) / 100,
              levelBonus: Number(d[6]) / 100,
            };
          } catch { /* keep zeros */ }
        }
        const slotIds = equippedByGen[g] ?? [0,0,0,0,0,0];
        const slots: (EquippedSlot | null)[] = [];
        for (let s = 0; s < 6; s++) {
          const id = slotIds[s];
          if (id === 0) { slots.push(null); continue; }
          equippedSet.add(id);
          const meta = itemMeta.get(id);
          if (!meta) { slots.push(null); continue; }
          const resolved = this.resolveItem(id, meta);
          if (!resolved) { slots.push(null); continue; }
          slots.push({ category: ITEM_TYPES[s+1] ?? '?', ...resolved });
        }
        // Compute live Vault projection for this loadout if cycle data is fresh.
        const projection = computeVaultProjection(agg, this.latest.cycle, Math.floor(Date.now() / 1000));
        generators.push({ id: g, ...agg, slots, vaultProjection: projection });
      }

      // Build inventory view (mark equipped items)
      const inventory: InventoryItem[] = [];
      for (const id of invItemIds) {
        const meta = itemMeta.get(id);
        if (!meta) continue;
        const tpl = this.templates.get(meta.templateId);
        if (!tpl) continue;
        const m = RARITY_MULT[meta.rarity] ?? 1;
        inventory.push({
          itemId: id,
          templateId: meta.templateId,
          rarity: meta.rarity,
          rarityName: RARITY_NAMES[meta.rarity] ?? '?',
          rarityMult: m,
          name: tpl.name,
          type: tpl.type,
          cr: tpl.cr * m, hp: tpl.hp * m, eff: tpl.eff * m,
          bc: tpl.bc * m, bm: tpl.bm * m, disc: tpl.disc * m,
          equipped: equippedSet.has(id),
        });
      }

      return {
        address: addr,
        statusLevel: Number(profile.level),
        statusXp:    Number(profile.xp),
        generators,
        inventory,
        inventoryCount: invItemIds.length,
      };
    } catch (err: any) {
      // Privacy: log only the hashed tag, never the raw wallet. This path
      // is reachable from the public /api/track/:wallet endpoint, so the
      // raw addr would otherwise hit pm2 disk logs on RPC failure.
      logger.warn({ err: err.message, walletTag: walletLogTag(addr) }, '[LoadoutScanner] fetchUserView failed');
      return null;
    }
  }

  /** Refresh the operator's own loadout view + cycle metadata; emits 'user'. */
  private async refreshSelf() {
    if (!this.cfg.walletAddress) return;
    await this.refreshCycle();
    const view = await this.fetchUserView(this.cfg.walletAddress);
    if (!view) return;
    this.latest.user = view;
    this.emit('user', this.latest.user);
  }

  /**
   * Scan TradeCompleted + TradeLiquidated events network-wide to rank
   * players. Returns per-player wins/losses/SR + DIRTY earned. The
   * `opsCount` aggregates wins+losses (total volume); `wins` and
   * `losses` separate them so callers can compute SR or rank by it.
   */
  private async rankPlayersFromChain(): Promise<{
    address: string;
    opsCount: number;       // total = wins + losses
    wins: number;           // TC count
    losses: number;         // TL count
    successRate: number;    // wins / total, or 0 when total==0
    dirtyEarned: number;
  }[]> {
    const lookback = this.cfg.rankingLookbackBlocks ?? 100_000;
    const latest = await this.provider.getBlockNumber();
    const start  = latest - lookback;

    // Pull events in 5k-block chunks (RPC max range)
    const playerWins:   Record<string, number> = {};
    const playerLosses: Record<string, number> = {};
    const playerDirty:  Record<string, number> = {};
    const CHUNK = 5000;
    let scanned = 0;
    for (let from = start; from < latest; from += CHUNK) {
      const to = Math.min(from + CHUNK - 1, latest);
      // TradeCompleted (success) — tally as a WIN
      try {
        const tcLogs = await this.provider.getLogs({
          fromBlock: from, toBlock: to, topics: [TC_TOPIC],
        });
        for (const log of tcLogs) {
          if (!log.topics[1]) continue;
          const player = '0x' + log.topics[1].slice(-40);
          playerWins[player] = (playerWins[player] ?? 0) + 1;
          // data[0] = reward (uint256). 32 bytes after 0x = 64 hex.
          if (log.data && log.data.length >= 66) {
            try {
              const reward = Number(BigInt('0x' + log.data.slice(2, 66))) / 1e18;
              playerDirty[player] = (playerDirty[player] ?? 0) + reward;
            } catch { /* skip */ }
          }
        }
      } catch (err: any) {
        logger.warn({ err: err.message, from, to }, '[LoadoutScanner] TC chunk failed');
      }
      // TradeLiquidated (failure) — tally as a LOSS. Partial reward
      // still counts toward DIRTY earned (some ops pay out reduced
      // rewards on liquidation per partial-fail mechanics).
      try {
        const tlLogs = await this.provider.getLogs({
          fromBlock: from, toBlock: to, topics: [TL_TOPIC],
        });
        for (const log of tlLogs) {
          if (log.topics.length < 4) continue;
          const player = '0x' + log.topics[2].slice(-40);
          playerLosses[player] = (playerLosses[player] ?? 0) + 1;
          // data[1] = partialReward
          if (log.data && log.data.length >= 130) {
            try {
              const reward = Number(BigInt('0x' + log.data.slice(66, 130))) / 1e18;
              playerDirty[player] = (playerDirty[player] ?? 0) + reward;
            } catch { /* skip */ }
          }
        }
      } catch { /* skip chunk */ }
      scanned += CHUNK;
    }

    const allPlayers = new Set([...Object.keys(playerWins), ...Object.keys(playerLosses)]);
    const ranked = [...allPlayers].map(addr => {
      const wins = playerWins[addr] ?? 0;
      const losses = playerLosses[addr] ?? 0;
      const total = wins + losses;
      return {
        address: addr,
        opsCount: total,
        wins,
        losses,
        successRate: total > 0 ? wins / total : 0,
        dirtyEarned: playerDirty[addr] ?? 0,
      };
    }).sort((a, b) => b.opsCount - a.opsCount);

    logger.info({ players: ranked.length, scanned: lookback }, '[LoadoutScanner] ranking built');
    return ranked;
  }

  /**
   * Rank players by USDM claimed from CycleRewards in the last
   * `claimRankWindowMs` window. This is the PRIMARY ranking metric as of
   * 2026-05-09 — replaces the previous ops-count ranking which rewarded
   * activity over actual yield. Top earners by claim USDM are the real
   * laundering-meta winners.
   *
   * Returns null if storage isn't wired or claim data is sparse — callers
   * fall back to the ops-based ranking in that case.
   */
  private rankPlayersByClaims(): { address: string; claimUsdm: number; claimsCount: number }[] | null {
    if (!this.cfg.storage) return null;
    const windowMs = this.cfg.claimRankWindowMs ?? 7 * 86400_000;
    const sinceMs = Date.now() - windowMs;
    try {
      const stmt = (this.cfg.storage as any).db.prepare(`
        SELECT claimer, SUM(usdm_amount) total_usdm, COUNT(*) n
        FROM whale_claims WHERE ts >= ?
        GROUP BY claimer ORDER BY total_usdm DESC
      `);
      const rows = stmt.all(sinceMs) as { claimer: string; total_usdm: number; n: number }[];
      const MIN_CLAIMERS_FOR_RANK = 10;
      if (rows.length < MIN_CLAIMERS_FOR_RANK) return null;
      return rows.map(r => ({
        address: r.claimer.toLowerCase(),
        claimUsdm: r.total_usdm,
        claimsCount: r.n,
      }));
    } catch (err: any) {
      logger.warn({ err: err.message }, '[LoadoutScanner] claim-based ranking failed');
      return null;
    }
  }

  /** Refresh network meta — popularity stats + top players' loadouts. Slow. */
  private async refreshNetwork() {
    try {
      // Run BOTH ranking paths so we have ops/dirty as secondary metrics.
      const opsRanking = await this.rankPlayersFromChain();
      if (opsRanking.length === 0) {
        logger.debug('[LoadoutScanner] no ranked players — skipping');
        return;
      }

      // Try claim-based ranking first (preferred). If too sparse, fall back.
      const claimRanking = this.rankPlayersByClaims();
      const useClaimRank = claimRanking !== null;
      logger.info(
        { claimers: claimRanking?.length ?? 0, opsPlayers: opsRanking.length, primary: useClaimRank ? 'claim_usdm' : 'ops_count' },
        '[LoadoutScanner] ranking source decided',
      );

      // Build the master ranking. When claim-based is active:
      //   1. Top by claim_usdm (the actual money winners)
      //   2. Plus everyone from ops-ranking who isn't already in claim-ranking
      //      (so we don't lose data on active grinders who just haven't claimed yet)
      const opsByAddr = new Map(opsRanking.map(r => [r.address.toLowerCase(), r]));

      type Row = { address: string; opsCount: number; wins: number; losses: number;
                   successRate: number; dirtyEarned: number;
                   claimUsdm: number; claimsCount: number; rankMetric: 'claim_usdm' | 'ops_count' };
      const rankedRows: Row[] = [];
      const seen = new Set<string>();

      if (useClaimRank) {
        for (const c of claimRanking!) {
          const ops = opsByAddr.get(c.address);
          rankedRows.push({
            address: c.address,
            claimUsdm: c.claimUsdm,
            claimsCount: c.claimsCount,
            opsCount: ops?.opsCount ?? 0,
            wins:        ops?.wins        ?? 0,
            losses:      ops?.losses      ?? 0,
            successRate: ops?.successRate ?? 0,
            dirtyEarned: ops?.dirtyEarned ?? 0,
            rankMetric: 'claim_usdm',
          });
          seen.add(c.address);
        }
      }
      // Append ops-ranked players not yet in the list, ranked by ops count
      for (const r of opsRanking) {
        const a = r.address.toLowerCase();
        if (seen.has(a)) continue;
        rankedRows.push({
          address: a,
          claimUsdm: 0,
          claimsCount: 0,
          opsCount: r.opsCount,
          wins:        r.wins,
          losses:      r.losses,
          successRate: r.successRate,
          dirtyEarned: r.dirtyEarned,
          rankMetric: useClaimRank ? 'ops_count' : 'ops_count',
        });
      }

      const ranked = rankedRows;
      // Cap the scan to the top 200 players to keep RPC pressure reasonable.
      // Network meta needs aggregation across the whole field, but we don't
      // need to fetch loadouts for the long tail.
      const scanLimit = Math.min(ranked.length, 200);
      const scanned = ranked.slice(0, scanLimit);

      // Pull generators for the bounded scan set in one batch
      const players = scanned.map(p => p.address);
      const callsGens = players.map(p => ({
        target: GEN_MGR, allowFailure: true,
        callData: this.genIface.encodeFunctionData('getUserGenerators', [p]),
      }));

      // MegaETH RPC returns 413 above ~150 calls; cap at 120 for headroom.
      const genResults = await this.batchedAggregate3(callsGens, 120);

      const playerGens: { address: string; gens: number[] }[] = [];
      for (let i = 0; i < players.length; i++) {
        if (!genResults[i] || !genResults[i].success) continue;
        try {
          const arr = this.genIface.decodeFunctionResult('getUserGenerators', genResults[i].returnData)[0]
            .map((x: bigint) => Number(x));
          if (arr.length > 0) playerGens.push({ address: players[i], gens: arr });
        } catch { /* skip */ }
      }

      // Now batch all (equipped + aggregate stats) calls
      const flat: { kind: 'eq' | 'st'; player: string; gen: number; idx: number }[] = [];
      const callsGenStats: any[] = [];
      for (const pg of playerGens) {
        for (const g of pg.gens) {
          flat.push({ kind: 'eq', player: pg.address, gen: g, idx: callsGenStats.length });
          callsGenStats.push({ target: GEN_MGR, allowFailure: true,
            callData: this.genIface.encodeFunctionData('getEquippedItems', [g]) });
          flat.push({ kind: 'st', player: pg.address, gen: g, idx: callsGenStats.length });
          callsGenStats.push({ target: GEN_MGR, allowFailure: true,
            callData: this.genIface.encodeFunctionData('getAggregateStats', [g]) });
        }
      }
      const genStatRes = await this.batchedAggregate3(callsGenStats, 120);

      // Decode and collect item IDs
      const equippedByGen: Record<string, number[]> = {};   // key = `${player}|${gen}`
      const statsByGen:    Record<string, any> = {};
      const allItemIds = new Set<number>();
      let eqOk = 0, eqFail = 0, eqDecodeFail = 0;
      for (const f of flat) {
        const r = genStatRes[f.idx];
        const key = `${f.player}|${f.gen}`;
        if (!r || !r.success) {
          if (f.kind === 'eq') eqFail++;
          continue;
        }
        try {
          if (f.kind === 'eq') {
            const decoded = this.genIface.decodeFunctionResult('getEquippedItems', r.returnData);
            // Fixed-size array — wrap in Array.from for safe iteration
            const arr = Array.from(decoded[0] as any[]).map((x: any) => Number(x));
            equippedByGen[key] = arr;
            for (const id of arr) if (id > 0) allItemIds.add(id);
            eqOk++;
          } else {
            const d = this.genIface.decodeFunctionResult('getAggregateStats', r.returnData);
            statsByGen[key] = {
              hp:Number(d[0]), cr:Number(d[1]),
              eff:Number(d[2])/100, bc:Number(d[3])/100,
              bm:Number(d[4])/100, disc:Number(d[5])/100,
              levelBonus:Number(d[6])/100,
            };
          }
        } catch (err: any) {
          if (f.kind === 'eq') eqDecodeFail++;
        }
      }
      logger.info({ eqOk, eqFail, eqDecodeFail, items: allItemIds.size },
        '[LoadoutScanner] equipped-items decode summary');

      // Resolve every unique item ID (templateId + rarity)
      const idList = Array.from(allItemIds);
      const itemCalls = idList.map(id => ({
        target: GEN_MGR, allowFailure: true,
        callData: this.genIface.encodeFunctionData('getItem', [id]),
      }));
      const itemRes = await this.batchedAggregate3(itemCalls, 120);
      const itemMeta = new Map<number, { templateId: number; rarity: number }>();
      for (let i = 0; i < idList.length; i++) {
        const r = itemRes[i];
        if (!r || !r.success) continue;
        try {
          const dec = this.genIface.decodeFunctionResult('getItem', r.returnData)[0];
          itemMeta.set(idList[i], {
            templateId: Number(dec.templateId),
            rarity:     Number(dec.rarity),
          });
        } catch { /* skip */ }
      }

      // Aggregate network counts + build top-player generator views
      const templateCount: Record<number, number> = {};
      const templateRarityCount: Record<string, number> = {}; // key: `${tid}|${rarity}`

      // Map by lowercased address — case-mixed addresses occasionally show
      // up across feeds. Storage stores lowercased; chain logs return mixed.
      const playerInfoByAddr = new Map<string, Row>();
      for (const p of scanned) playerInfoByAddr.set(p.address.toLowerCase(), p);

      const topPlayers: TopPlayerView[] = [];
      const topN = this.cfg.topPlayerCount ?? 5;
      let countedLoadouts = 0;

      for (const pg of playerGens) {
        const info = playerInfoByAddr.get(pg.address.toLowerCase());
        const playerView: TopPlayerView = {
          address: pg.address,
          rank: scanned.findIndex(r => r.address === pg.address) + 1,
          claimUsdm7d:   info?.claimUsdm   ?? 0,
          claimsCount7d: info?.claimsCount ?? 0,
          opsCount:      info?.opsCount    ?? 0,
          dirtyEarned:   info?.dirtyEarned ?? 0,
          rankMetric:    info?.rankMetric  ?? 'ops_count',
          generators: [],
          balances: null,           // filled in Tier 2 enrichment below
          corpCount: 0,             // filled below
          corps: [],                // filled below
        };
        for (const g of pg.gens) {
          const key = `${pg.address}|${g}`;
          const slotIds = equippedByGen[key];
          if (!slotIds) continue;
          countedLoadouts++;

          // Tally counts
          for (const id of slotIds) {
            if (id === 0) continue;
            const m = itemMeta.get(id);
            if (!m) continue;
            templateCount[m.templateId] = (templateCount[m.templateId] ?? 0) + 1;
            const rk = `${m.templateId}|${m.rarity}`;
            templateRarityCount[rk] = (templateRarityCount[rk] ?? 0) + 1;
          }

          // Build the per-generator slot view (only for top N)
          if (topPlayers.length < topN) {
            const stats = statsByGen[key] ?? { hp:0,cr:0,eff:0,bc:0,bm:0,disc:0,levelBonus:0 };
            const slots: (EquippedSlot | null)[] = [];
            for (let s = 0; s < 6; s++) {
              const id = slotIds[s];
              if (id === 0) { slots.push(null); continue; }
              const meta = itemMeta.get(id);
              if (!meta) { slots.push(null); continue; }
              const resolved = this.resolveItem(id, meta);
              if (!resolved) { slots.push(null); continue; }
              slots.push({ category: ITEM_TYPES[s+1] ?? '?', ...resolved });
            }
            playerView.generators.push({ id: g, ...stats, slots });
          }
        }
        if (topPlayers.length < topN && playerView.generators.length > 0) {
          topPlayers.push(playerView);
        }
      }
      topPlayers.sort((a, b) => a.rank - b.rank);

      // ===== Tier 2: enrich top players with balances + corp ops =====
      // For each top player we add: INF/DIRTY/USDM balance, total corp count
      // (PL indicator), and per-corp current op state (mode, active, pending).
      // Uses 3 batched multicalls — under 1s wall time for 10 players.
      try {
        await this.enrichTopPlayers(topPlayers);
      } catch (err: any) {
        logger.warn({ err: err.message }, '[LoadoutScanner] enrichTopPlayers failed');
      }

      // Build network stats
      const topEquipped: NetworkAssetStat[] = [];
      const sorted = Object.entries(templateCount)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 30);
      for (const [tidStr, total] of sorted) {
        const tid = Number(tidStr);
        const tpl = this.templates.get(tid);
        if (!tpl) continue;
        const byRarity = [0,0,0,0,0,0];
        for (let r = 1; r <= 5; r++) {
          byRarity[r] = templateRarityCount[`${tid}|${r}`] ?? 0;
        }
        topEquipped.push({
          templateId: tid, name: tpl.name, type: tpl.type,
          total, byRarity,
        });
      }

      const topByCategory: Record<string, NetworkAssetStat[]> = {};
      for (const cat of ITEM_TYPES.slice(1)) {
        topByCategory[cat] = topEquipped
          .filter(s => s.type === cat)
          .slice(0, 5);
      }

      const topLegendaries: NetworkAssetStat[] = [];
      const legArr: { tid: number; count: number }[] = [];
      for (const [k, n] of Object.entries(templateRarityCount)) {
        const [tidStr, rStr] = k.split('|');
        if (Number(rStr) === 4) legArr.push({ tid: Number(tidStr), count: n });
      }
      legArr.sort((a, b) => b.count - a.count);
      for (const e of legArr.slice(0, 15)) {
        const tpl = this.templates.get(e.tid);
        if (!tpl) continue;
        const byRarity = [0,0,0,0,0,0];
        byRarity[4] = e.count;
        topLegendaries.push({
          templateId: e.tid, name: tpl.name, type: tpl.type,
          total: e.count, byRarity,
        });
      }

      this.latest.network = {
        totalLoadouts: countedLoadouts,
        topEquipped,
        topByCategory,
        topLegendaries,
        lastScanTs: Date.now(),
      };
      this.latest.topPlayers = topPlayers;

      // Build the TOP-SR leaderboard from the same opsRanking dataset.
      // Min ops threshold (default 50) filters out small-sample noise —
      // a wallet with 5 wins out of 5 ops is statistically uninteresting
      // since the network's 60% baseline gives ~8% chance of that by luck.
      const SR_MIN_OPS = 50;
      const SR_TOP_N = 25;
      const claimByAddrLc = new Map<string, number>(
        (claimRanking ?? []).map(c => [c.address.toLowerCase(), c.claimUsdm]),
      );
      const srEligible = opsRanking
        .filter(r => r.opsCount >= SR_MIN_OPS)
        .sort((a, b) => b.successRate - a.successRate);
      const topBySr: TopBySrEntry[] = srEligible.slice(0, SR_TOP_N).map((r, i) => ({
        address: r.address.toLowerCase(),
        rank: i + 1,
        wins: r.wins,
        losses: r.losses,
        opsCount: r.opsCount,
        successRate: r.successRate,
        dirtyEarned: r.dirtyEarned,
        claimUsdm: claimByAddrLc.get(r.address.toLowerCase()) ?? 0,
      }));
      this.latest.topBySr = topBySr;

      this.emit('network', this.latest);
      logger.info({
        loadouts: countedLoadouts,
        topPlayers: topPlayers.length,
        topAssets: topEquipped.length,
        topBySr: topBySr.length,
        srLeader: topBySr[0] ? `${topBySr[0].address.slice(0,10)}.. ${(topBySr[0].successRate*100).toFixed(1)}%` : 'none',
      }, '[LoadoutScanner] network scan complete');
    } catch (err: any) {
      logger.warn({ err: err.message }, '[LoadoutScanner] refreshNetwork failed');
    }
  }

  /**
   * Enrich the top-N players with balances + per-corp op state. Three batched
   * multicalls (one for balances, one for corp lists, one for trade info on
   * every corp). Mutates the input array in place.
   */
  private async enrichTopPlayers(players: TopPlayerView[]): Promise<void> {
    if (players.length === 0) return;

    // --- Batch 1: token balances (INF, DIRTY, USDM) for each player ---
    const balCalls: any[] = [];
    for (const p of players) {
      for (const tok of [TOKEN_INF, TOKEN_DIRTY, TOKEN_USDM]) {
        balCalls.push({
          target: tok, allowFailure: true,
          callData: this.tokenIface.encodeFunctionData('balanceOf', [p.address]),
        });
      }
    }
    const balRes = await this.batchedAggregate3(balCalls, 100);
    for (let i = 0; i < players.length; i++) {
      const inf   = this.decodeBalance(balRes[i*3 + 0]);
      const dirty = this.decodeBalance(balRes[i*3 + 1]);
      const usdm  = this.decodeBalance(balRes[i*3 + 2]);
      players[i].balances = { inf, dirty, usdm };
    }

    // --- Batch 2: getUserCompanies (corp address arrays) per player ---
    const corpListCalls = players.map(p => ({
      target: USER_FACTORY, allowFailure: true,
      callData: this.factoryIface.encodeFunctionData('getUserCompanies', [p.address]),
    }));
    const corpListRes = await this.batchedAggregate3(corpListCalls, 100);
    const playerCorps: { addr: string; corps: string[] }[] = [];
    for (let i = 0; i < players.length; i++) {
      const r = corpListRes[i];
      let corps: string[] = [];
      if (r && r.success) {
        try {
          corps = this.factoryIface.decodeFunctionResult('getUserCompanies', r.returnData)[0];
        } catch { /* skip */ }
      }
      players[i].corpCount = corps.length;
      playerCorps.push({ addr: players[i].address, corps });
    }

    // --- Batch 3: getTradeInfo + locationId for every corp across all players ---
    // Each corp returns ALL the per-trade fields in one call. Plus we need
    // locationId separately. So 2 calls per corp.
    type CorpRef = { playerIdx: number; corpAddr: string };
    const corpRefs: CorpRef[] = [];
    const tradeCalls: any[] = [];
    for (let pi = 0; pi < playerCorps.length; pi++) {
      for (const corpAddr of playerCorps[pi].corps) {
        corpRefs.push({ playerIdx: pi, corpAddr });
        tradeCalls.push({
          target: corpAddr, allowFailure: true,
          callData: this.corpIface.encodeFunctionData('getTradeInfo', []),
        });
        tradeCalls.push({
          target: corpAddr, allowFailure: true,
          callData: this.corpIface.encodeFunctionData('locationId', []),
        });
        tradeCalls.push({
          target: corpAddr, allowFailure: true,
          callData: this.corpIface.encodeFunctionData('autoTradeEnabled', []),
        });
        tradeCalls.push({
          target: corpAddr, allowFailure: true,
          callData: this.corpIface.encodeFunctionData('pendingReward', []),
        });
      }
    }
    const tradeRes = await this.batchedAggregate3(tradeCalls, 120);

    // Stitch results back into per-player corp ops
    let cursor = 0;
    for (const ref of corpRefs) {
      const ti  = tradeRes[cursor++];   // getTradeInfo
      const li  = tradeRes[cursor++];   // locationId
      const aei = tradeRes[cursor++];   // autoTradeEnabled
      const pri = tradeRes[cursor++];   // pendingReward

      let active = false, mode = 0, startTime = 0, endTime = 0, influence = 0;
      let location = 0, autoEnabled = false, pendingDirty = 0;
      try {
        if (ti && ti.success) {
          const d = this.corpIface.decodeFunctionResult('getTradeInfo', ti.returnData);
          active     = Boolean(d[0]);
          mode       = Number(d[1]);
          startTime  = Number(d[4]);
          endTime    = Number(d[5]);
          influence  = Number(d[6]) / 1e18;
        }
        if (li && li.success)  location     = Number(this.corpIface.decodeFunctionResult('locationId', li.returnData)[0]);
        if (aei && aei.success) autoEnabled = Boolean(this.corpIface.decodeFunctionResult('autoTradeEnabled', aei.returnData)[0]);
        if (pri && pri.success) pendingDirty = Number(this.corpIface.decodeFunctionResult('pendingReward', pri.returnData)[0]) / 1e18;
      } catch { /* skip bad corp */ }

      players[ref.playerIdx].corps.push({
        address: ref.corpAddr,
        locationId: location,
        autoEnabled,
        mode,
        modeName: MODE_NAMES_ABBREV[mode] ?? `mode${mode}`,
        active,
        tradeStartTs: startTime,
        tradeEndTs:   endTime,
        influence,
        pendingDirty,
      });
    }
  }

  /** Decode a balanceOf result. Returns 0 on any failure. */
  private decodeBalance(r: any): number {
    if (!r || !r.success) return 0;
    try {
      return Number(this.tokenIface.decodeFunctionResult('balanceOf', r.returnData)[0]) / 1e18;
    } catch {
      return 0;
    }
  }

  /** Multicall in chunks to stay under the RPC's max-batch limit. */
  private async batchedAggregate3(calls: any[], batchSize: number): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < calls.length; i += batchSize) {
      const slice = calls.slice(i, i + batchSize);
      try {
        const res = await this.mc.aggregate3.staticCall(slice);
        for (const r of res) out.push(r);
      } catch (err: any) {
        // On batch failure, fill with empties so indices stay aligned
        logger.warn({ err: err.message, batchStart: i, batchSize: slice.length },
          '[LoadoutScanner] batch failed; filling empties');
        for (let _ = 0; _ < slice.length; _++) out.push({ success: false, returnData: '0x' });
      }
    }
    return out;
  }
}
