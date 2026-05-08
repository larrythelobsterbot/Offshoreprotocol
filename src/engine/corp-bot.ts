/**
 * CorpBot — automatically switches between Drug (mode 2) and Arms (mode 1)
 * based on current danger score, and auto-claims when rewards are pending.
 *
 * Rules:
 *   dangerScore >= DANGER_HIGH  → switch all corps to Arms (safer, still earns)
 *   dangerScore <= DANGER_LOW   → switch all corps back to Drug (max DIRTY)
 *   hasPendingClaim             → claimRewards() on that corp
 *
 * Requires MAIN_KEY in .env — corp ownership is non-transferable, so the bot
 * must sign with the same wallet that created the corps.
 */

import { ethers } from 'ethers';
import { logger } from '../logger';
import type { TgBot } from './tgbot';
import type { WalletBalances } from '../feeds/onchain-balances';

const RPC = 'https://mainnet.megaeth.com/rpc';

const CORP_ABI = [
  // reads
  'function autoTradeEnabled() view returns (bool)',
  'function autoTradeMode() view returns (uint8)',
  'function hasPendingClaim() view returns (bool)',
  'function pendingReward() view returns (uint256)',
  'function isTradeActive() view returns (bool)',
  'function isCompletable() view returns (bool)',
  'function getCooldownEnd() view returns (uint256)',
  'function owner() view returns (address)',
  // writes
  'function enableAutoTrade(uint8 mode) external',   // 0=Extortion 1=Arms 2=Drug
  'function disableAutoTrade() external',
  'function startTrade(uint8 mode) external',        // bootstrap the FIRST trade — auto-restart only fires after an initial startTrade
  'function completeTrade() external',               // finalize a finished trade (triggers auto-restart if enabled)
  'function claimRewards() external',
];

// Default danger thresholds for mode switching. These are tunable at runtime
// via setThresholds() (e.g. from a Telegram /bot thresholds command).
const DEFAULT_DANGER_HIGH = 65;
const DEFAULT_DANGER_LOW  = 45;

// Modes (matches contract: enableAutoTrade(uint8))
const MODE_EXTORTION = 0;
const MODE_ARMS      = 1;
const MODE_DRUG      = 2;
const MODE_NAMES = ['Extortion', 'Arms', 'Drug'] as const;

// How often to poll corp state (ms)
const POLL_INTERVAL_MS = 30_000; // every 30s

// Minimum time between mode-switch transactions per corp (ms)
const MODE_SWITCH_COOLDOWN_MS = 120_000; // 2 min — avoid tx spam on noisy scores

// In-memory log ring buffer size — surfaced via /bot logs.
const LOG_BUFFER_SIZE = 50;

// HKT timezone — operator is in Hong Kong, scheduling is HKT-aware.
const HKT_OFFSET_HOURS = 8;

// Danger override threshold — above this we ignore the schedule and force
// the panic preset. Tunable via /bot dangerthreshold or kept aligned with
// dangerHigh.
const DEFAULT_PANIC_THRESHOLD = 75;

/**
 * A loadout preset. `modes` maps directly to corp index → operating mode.
 * `paused: true` means we call disableAutoTrade() on every corp instead.
 *
 * Built in three "preset" tiers:
 *   - Operating presets: corps run in specified modes
 *   - Pause preset: stops auto-trade entirely (saves INF in dead zones)
 *   - Custom: user-defined via /bot custom
 */
export interface BotPreset {
  name: string;
  modes: number[];      // mode per corp index — 0/1/2 (Ext/Arms/Drug)
  paused?: boolean;     // if true, ignore modes and call disableAutoTrade()
}

/** Snapshot of bot state for the operator's /bot command. */
export interface CorpBotStatus {
  running: boolean;
  paused: boolean;            // legacy operator-pause flag
  signer: string | null;
  ownedCorps: number;
  totalCorps: number;
  // Per-corp targets and active preset name (replaces legacy single targetMode)
  activePresetName: string;   // e.g. 'safe', 'all-drug', 'manual:custom', 'auto:safe'
  targetModes: number[];      // per-corp target modes
  scheduleMode: 'auto' | 'manual';   // is bot following schedule, or locked?
  scheduleEnabled: boolean;
  hktHour: number;            // current HKT hour for context
  schedulePresetThisHour: string | null; // schedule-derived preset for current HKT hour
  dangerHigh: number;
  dangerLow: number;
  panicThreshold: number;
  lastDanger: number | null;
  inDangerState: boolean;
  perCorp: { addr: string; auto: boolean; mode: number; modeName: string }[];
  recentLogs: string[];
  // Circuit breaker state — non-null when tripped, with seconds remaining.
  circuitBreaker: {
    tripped: boolean;
    cooldownSecondsRemaining: number;
    recentLiquidationCount: number; // distinct corps in current window
    windowSeconds: number;
    threshold: number;
    totalTrips: number;
  };
  // Wallet balances surfaced from OnchainBalancesFeed (null when unavailable).
  balances: {
    inf: number;
    dirty: number;
    usdm: number;
    infPerHr: number | null;
    dirtyPerHr: number | null;
    usdmPerHr: number | null;
  } | null;
}

export interface CorpBotConfig {
  corps: string[];
  // Optional Telegram notifier — DMs the operator on mode switches and claims.
  tgBot?: TgBot | null;
  operatorChatId?: number | null;
  // Optional accessor for wallet balances (so /bot status can surface them).
  // Implemented as a getter rather than a snapshot so /bot always shows the
  // freshest data from OnchainBalancesFeed without us re-fetching.
  getWalletBalances?: () => WalletBalances | null;
}

export class CorpBot {
  private signer: ethers.Wallet | null = null;
  private provider: ethers.JsonRpcProvider;
  private contracts: ethers.Contract[] = [];
  private corps: string[] = [];
  private tgBot: TgBot | null;
  private operatorChatId: number | null;
  private getWalletBalances: (() => WalletBalances | null) | null;

  // Track last mode-switch time per corp to debounce noisy transitions
  private lastSwitch: Map<string, number> = new Map();

  // ===== Preset / schedule system =====
  // The bot picks one preset per tick. A preset is either:
  //   - operating mode array (one mode per corp), or
  //   - paused (disableAutoTrade on all corps)
  //
  // Selection logic, in priority order:
  //   1. Manual override (operator ran /bot preset xxx) — locks bot to preset
  //   2. Danger override (dangerScore >= panicThreshold) — uses 'panic' preset
  //   3. Schedule lookup (HKT-hour → preset name) — if schedule enabled
  //   4. Fallback default — 'all-drug'
  //
  // The result becomes `targetModes` (or paused state) for this tick.

  // Built-in presets. Operator can also define custom ones via setCustomPreset().
  private presets: Record<string, BotPreset> = {};

  // Manual override — when set, bot ignores schedule + danger override.
  // Cleared by /bot preset auto.
  private manualPresetName: string | null = null;

  // 24-element array indexed by HKT hour [0..23]. Each entry is a preset name.
  private schedule: string[] = [];

  // Whether the schedule is active. When false, bot uses 'all-drug' as default
  // unless danger override or manual override kicks in.
  private scheduleEnabled: boolean = true;

  // Current resolved preset name (e.g. 'safe' / 'all-drug' / 'panic' / 'manual:custom')
  private activePresetName: string = 'all-drug';

  // Current per-corp target modes (derived from active preset)
  private targetModes: number[] = [];

  // Whether current preset is paused (corps should have auto-trade OFF)
  private targetPaused: boolean = false;

  // Track when we last DM'd a preset change to avoid spamming the operator
  // when the schedule + danger flip rapidly.
  private lastPresetChangeAt: number = 0;
  private static readonly PRESET_CHANGE_DM_COOLDOWN_MS = 5 * 60_000;
  private lastNotifiedPreset: string | null = null;

  // ===== Circuit breaker =====
  // Watches OUR OWN corps' liquidation events (NOT market-wide — the
  // OpScraperFeed filters logs by `address: <our_corps>` so only events on
  // our wallet's corps reach recordLiquidation). If N distinct corps liquidate
  // within the rolling window, force-pause for the cooldown. Catches the
  // "rapid serial liquidation" failure mode where sustained ETH volatility
  // burns INF faster than the danger-score-based panic preset can react.
  //
  // Triggers from OpScraperFeed → recordLiquidation(corp). Independent of
  // the danger score — this is a reactive safety net based on observed losses.
  private recentLiqs: { corp: string; ts: number }[] = [];
  private circuitBreakerUntil: number = 0;
  private circuitBreakerTrips: number = 0; // diagnostic counter
  // Tunables (operator can change at runtime via /bot breaker config)
  private cbWindowMs: number    = 5 * 60_000;   // distinct-corp liq window
  private cbThreshold: number   = 2;            // distinct corps to trip — 2 of OUR 6
  private cbCooldownMs: number  = 30 * 60_000;  // how long to hold pause

  // Runtime-tunable thresholds (operator can change via /bot thresholds H L).
  private dangerHigh: number = DEFAULT_DANGER_HIGH;
  private dangerLow:  number = DEFAULT_DANGER_LOW;
  // At and above this danger score, force the panic preset regardless of schedule.
  private panicThreshold: number = DEFAULT_PANIC_THRESHOLD;

  // Last danger score we observed (so /bot status can show it).
  private lastDanger: number | null = null;

  // Hysteretic danger-state machine. Enter when lastDanger crosses the upper
  // band (min(dangerHigh, panicThreshold)); exit only when it drops back below
  // dangerLow. This prevents oscillation around a single threshold — without
  // hysteresis, scores wobbling around the line would flip the preset every tick
  // and spam mode-switch txs.
  private inDangerState: boolean = false;

  // Operator-controlled pause. When true, ticks fetch state but skip all
  // writes. Auto-trade keeps running at the contract level — we just don't
  // intervene. /bot pause sets this; /bot resume clears it.
  private paused: boolean = false;

  // Cached per-corp on-chain state from the most recent tick (powers /bot status
  // without an extra RPC roundtrip).
  private lastCorpSnapshot: { addr: string; auto: boolean; mode: number }[] = [];

  // Recent CorpBot log lines for /bot logs. Append-only, capped.
  private logBuffer: string[] = [];

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  // Reentrancy guard — true while a tick is mid-flight. Prevents two ticks
  // from observing the same pending-claim/wrong-mode and double-submitting.
  private tickInFlight = false;
  // Tracked so shutdown can await a finishing tick rather than killing it mid-tx.
  private currentTick: Promise<void> | null = null;
  private stopping = false;

  constructor(cfg: CorpBotConfig | string[]) {
    // Backwards compatible — string[] is treated as { corps }
    const config: CorpBotConfig = Array.isArray(cfg) ? { corps: cfg } : cfg;
    this.corps             = config.corps;
    this.tgBot             = config.tgBot ?? null;
    this.operatorChatId    = config.operatorChatId ?? null;
    this.getWalletBalances = config.getWalletBalances ?? null;
    this.provider          = new ethers.JsonRpcProvider(RPC);

    // Default per-corp targets — all Drug to start.
    this.targetModes = this.corps.map(() => MODE_DRUG);

    // Initialize built-in presets. We DELIBERATELY exclude Extortion-based
    // presets — operator does not want to run 5min ops (liquidation threshold
    // is just 0.039% ETH move, way too risky in any meaningful volatility).
    //
    // Strategy reasoning (from docs):
    //   - Drug: 90min, 0.518% liq threshold — best in volatile markets (highest tolerance)
    //   - Arms: 30min, 0.176% liq threshold — best in CALM markets (3x more cycles/hr → 3x DIRTY/hr)
    //   - Extortion: 5min, 0.039% liq threshold — REMOVED (too fragile)
    //
    // The default schedule pairs calm hours with Arms (max cycle volume) and
    // volatile hours with Drug (highest threshold absorbs the moves).
    const n = this.corps.length;
    const fill = (m: number) => Array(n).fill(m);
    this.presets = {
      'all-drug':  { name: 'all-drug',  modes: fill(MODE_DRUG) },
      'all-arms':  { name: 'all-arms',  modes: fill(MODE_ARMS) },
      'mix-arms':  { name: 'mix-arms',  modes: this.fillMixed(MODE_ARMS, MODE_DRUG, n) },
      'mix-drug':  { name: 'mix-drug',  modes: this.fillMixed(MODE_DRUG, MODE_ARMS, n) },
      'paused':    { name: 'paused',    modes: fill(MODE_DRUG), paused: true },
      // 'panic' is what the danger override uses. We default to 'paused' (save
      // INF when even Drug's 0.518% threshold is getting blown through —
      // matches the operator's data showing 16/16 fails during US-open vol).
      'panic':     { name: 'panic',     modes: fill(MODE_DRUG), paused: true },
    };

    // Default 24-hour HKT schedule, derived from a 72h network-wide analysis
    // of 76,250 ops (May 7 2026). Per-op DIRTY yield (INF-constrained lens)
    // by hour informed each slot:
    //
    //   00h     → all-drug  (Drug d̄=52, sr=38% — marginal but net-positive vs idle)
    //   01-08h  → all-drug  (Drug d̄=58-95 vs Arms d̄=43-76 across the band)
    //   09h     → all-arms  (Arms d̄=53 vs Drug d̄=52 — slight Arms edge)
    //   10-13h  → all-drug  (Drug d̄=82-91 — calm Asia midday)
    //   14h     → all-arms  (Arms d̄=81 vs Drug d̄=79 — only hour Arms cleanly wins)
    //   15-19h  → all-drug  (Drug d̄=75-93 — peak hours; Drug edge widest)
    //   20h     → all-drug  (Drug d̄=74, sr=52% — strong; previously paused unnecessarily)
    //   21-22h  → paused    (21h sr=2/20%, 22h sr=23/6% — both catastrophic)
    //   23h     → all-drug  (Drug d̄=65, sr=33% — recovery hour)
    //
    // Reanalyze quarterly — meta drifts as the network composition changes.
    this.schedule = [
      'all-drug','all-drug','all-drug','all-drug','all-drug','all-drug','all-drug','all-drug',
      'all-drug','all-arms','all-drug','all-drug','all-drug','all-drug','all-arms','all-drug',
      'all-drug','all-drug','all-drug','all-drug','all-drug','paused',  'paused',  'all-drug',
    ];
  }

  /**
   * Build a "mixed" mode array — roughly 2/3 firstMode, 1/3 lastMode.
   * For 3 corps: [first, first, last]   → 2:1 (matches operator's stated 2 Arms + 1 Drug)
   * For 6 corps: [first×4, last×2]       → 4:2 (same ratio scaled up)
   * For 9 corps: [first×6, last×3]       → 6:3
   * Single corp: just lastMode.
   */
  private fillMixed(firstMode: number, lastMode: number, n: number): number[] {
    if (n <= 1) return [lastMode];
    const lastCount  = Math.max(1, Math.round(n / 3));
    const firstCount = n - lastCount;
    return [
      ...Array(firstCount).fill(firstMode),
      ...Array(lastCount).fill(lastMode),
    ];
  }

  /** Current Hong Kong hour (0-23). UTC + 8h, no DST. */
  private currentHKTHour(): number {
    const now = new Date();
    const utcHour = now.getUTCHours();
    return (utcHour + HKT_OFFSET_HOURS) % 24;
  }

  /**
   * Resolve which preset SHOULD be active right now, applying priority:
   *   circuit breaker → manual override → danger override → schedule → default.
   * Returns the preset along with a label like 'auto:safe' or 'manual:all-drug'.
   */
  private resolveActivePreset(): { preset: BotPreset; label: string } {
    // 0. Circuit breaker has TOP priority — observed liquidations trump
    //    every other signal. We keep auto-trade off until the cooldown clears.
    if (Date.now() < this.circuitBreakerUntil) {
      return { preset: this.presets['paused'], label: 'breaker:paused' };
    }
    // 1. Manual override
    if (this.manualPresetName && this.presets[this.manualPresetName]) {
      return { preset: this.presets[this.manualPresetName], label: `manual:${this.manualPresetName}` };
    }
    // 2. Danger override (HYSTERETIC).
    //    - Enter `panic` when score crosses min(dangerHigh, panicThreshold) upward.
    //    - Stay in `panic` until score drops to or below dangerLow.
    //    - panicThreshold defines the harder upper bound; dangerHigh is the
    //      soft entry; dangerLow is the release. With defaults (75/65/45) and
    //      a score wandering around 60-70 the bot stays in normal scheduling;
    //      a spike to 65+ triggers panic; only a return to <=45 releases it.
    if (this.lastDanger !== null) {
      const enterAt = Math.min(this.dangerHigh, this.panicThreshold);
      if (!this.inDangerState && this.lastDanger >= enterAt) {
        this.inDangerState = true;
        this.record('warn', `[CorpBot] Danger state ENTERED — score=${this.lastDanger} >= ${enterAt}`);
      } else if (this.inDangerState && this.lastDanger <= this.dangerLow) {
        this.inDangerState = false;
        this.record('info', `[CorpBot] Danger state RELEASED — score=${this.lastDanger} <= ${this.dangerLow}`);
      }
    }
    if (this.inDangerState) {
      return { preset: this.presets['panic'], label: `danger:panic` };
    }
    // 3. Schedule
    if (this.scheduleEnabled) {
      const hour = this.currentHKTHour();
      const name = this.schedule[hour];
      if (name && this.presets[name]) {
        return { preset: this.presets[name], label: `auto:${name}` };
      }
    }
    // 4. Fallback
    return { preset: this.presets['all-drug'], label: 'fallback:all-drug' };
  }

  /**
   * Called by index.ts whenever a TradeLiquidated event fires on one of our
   * corps. Tallies distinct corps in a rolling time window and trips the
   * breaker if the threshold is crossed.
   *
   * Critical: the caller must pass the EVENT TIMESTAMP, not Date.now(). When
   * the bot restarts, OpScraperFeed backfills missed events from its block
   * cursor — those events fire `recordLiquidation` with REAL timestamps that
   * may be hours old. If we tagged them with Date.now() (as we used to), a
   * batch of 5+ replayed liquidations from yesterday would all land in the
   * same artificial 5-min window and spuriously trip the breaker. Now we drop
   * any event older than the rolling window before counting.
   *
   * Also dedups by (corp, ts) so the same liquidation tx can't be processed
   * twice (e.g. two consecutive scraper polls catching overlapping ranges).
   */
  recordLiquidation(corp: string, eventTs: number, txHash?: string) {
    const now = Date.now();
    const ageMs = now - eventTs;

    // Ignore events older than the breaker window. They can't represent a
    // current threat — they're either a replay or a backfill catch-up.
    if (ageMs > this.cbWindowMs) {
      this.record('info',
        `[CorpBot] ignoring stale liquidation ${corp.slice(0,10)}.. age=${(ageMs/1000).toFixed(0)}s > window`);
      return;
    }

    const c = corp.toLowerCase();
    // Dedup: if we already have an entry for this corp at this exact event
    // timestamp, it's the same on-chain event seen twice — skip.
    if (this.recentLiqs.some(l => l.corp === c && l.ts === eventTs)) {
      return;
    }

    // Drop entries older than the window before tallying
    this.recentLiqs = this.recentLiqs.filter(l => now - l.ts < this.cbWindowMs);
    this.recentLiqs.push({ corp: c, ts: eventTs });

    // Count DISTINCT corps in window — we want "broad failure", not one corp
    // dying repeatedly (which is normal during routine liquidations).
    const distinct = new Set(this.recentLiqs.map(l => l.corp)).size;

    if (distinct >= this.cbThreshold && now >= this.circuitBreakerUntil) {
      this.tripCircuitBreaker(distinct);
    }
  }

  /** Manual operator action: pop the breaker early. Logs and clears state. */
  clearCircuitBreaker(): { wasTripped: boolean } {
    const wasTripped = Date.now() < this.circuitBreakerUntil;
    if (wasTripped) {
      this.circuitBreakerUntil = 0;
      this.recentLiqs = [];
      this.record('info', '[CorpBot] Circuit breaker manually CLEARED by operator');
      void this.notify('▶️ *Circuit breaker cleared.* Bot resumes schedule on next tick.', 'breaker-cleared');
      void this.runTick();
    }
    return { wasTripped };
  }

  /** Adjust circuit breaker tunables at runtime. */
  setCircuitBreakerConfig(cfg: { windowMs?: number; threshold?: number; cooldownMs?: number }):
      { ok: boolean; reason?: string } {
    if (cfg.windowMs !== undefined) {
      if (!Number.isFinite(cfg.windowMs) || cfg.windowMs < 30_000 || cfg.windowMs > 60 * 60_000) {
        return { ok: false, reason: 'windowMs must be between 30,000 and 3,600,000' };
      }
      this.cbWindowMs = cfg.windowMs;
    }
    if (cfg.threshold !== undefined) {
      if (!Number.isInteger(cfg.threshold) || cfg.threshold < 2 || cfg.threshold > 20) {
        return { ok: false, reason: 'threshold must be 2-20' };
      }
      this.cbThreshold = cfg.threshold;
    }
    if (cfg.cooldownMs !== undefined) {
      if (!Number.isFinite(cfg.cooldownMs) || cfg.cooldownMs < 60_000 || cfg.cooldownMs > 4 * 3600_000) {
        return { ok: false, reason: 'cooldownMs must be between 60,000 and 14,400,000' };
      }
      this.cbCooldownMs = cfg.cooldownMs;
    }
    this.record('info',
      `[CorpBot] Circuit breaker config: window=${this.cbWindowMs/1000}s threshold=${this.cbThreshold} cooldown=${this.cbCooldownMs/60000}m`);
    return { ok: true };
  }

  private tripCircuitBreaker(distinctCount: number) {
    const now = Date.now();
    this.circuitBreakerUntil = now + this.cbCooldownMs;
    this.circuitBreakerTrips++;
    const minutes = Math.round(this.cbCooldownMs / 60_000);
    const windowMin = (this.cbWindowMs / 60_000).toFixed(1);

    this.record('error',
      `[CorpBot] 🚨 CIRCUIT BREAKER TRIPPED — ${distinctCount} corps liquidated in ${windowMin}m. Pausing ${minutes}m.`);

    void this.notify(
      `🚨 *CIRCUIT BREAKER TRIPPED*\n\n` +
      `*${distinctCount} corps* liquidated in the last *${windowMin} min*.\n` +
      `Auto-trade disabled on all corps for *${minutes} min* to prevent INF burn.\n\n` +
      `Bot resumes schedule automatically at ${new Date(this.circuitBreakerUntil).toLocaleTimeString('en-US', { timeZone: 'Asia/Hong_Kong' })} HKT.\n` +
      `Manual clear: \`/bot breaker clear\``,
      'breaker-trip',
    );

    // Force an immediate tick — corps need to be disabled NOW, not in 30s
    void this.runTick();
  }

  // Outbound DM cooldown — prevents notification flooding if the danger score
  // oscillates rapidly around the 45/65 thresholds. One DM per (kind) per minute.
  private lastDmAt: Map<string, number> = new Map();
  private static readonly DM_COOLDOWN_MS = 60_000;

  /**
   * Push an entry into the in-memory log ring and forward to pino.
   * The buffer is what /bot logs surfaces — keeping it in-process avoids
   * shelling out to read PM2 log files just to answer a Telegram command.
   */
  private record(level: 'info' | 'warn' | 'error', msg: string, meta?: object) {
    const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
    const line = `${ts} ${level.toUpperCase()} ${msg}`;
    this.logBuffer.push(line);
    if (this.logBuffer.length > LOG_BUFFER_SIZE) {
      this.logBuffer.shift();
    }
    // Mirror to pino so PM2 logs still show everything as before.
    if (level === 'error')      logger.error(meta ?? {}, msg);
    else if (level === 'warn')  logger.warn(meta ?? {}, msg);
    else                        logger.info(meta ?? {}, msg);
  }

  /** Fire a DM to the operator if Telegram is wired up. Best-effort, never throws.
   *  `kind` is a category key for cooldown bucketing (e.g. 'mode-arm', 'claim'). */
  private async notify(text: string, kind: string = 'general'): Promise<void> {
    if (!this.tgBot || !this.operatorChatId) return;

    // Validate chat ID is a real integer (defends against parseInt('123abc')→123).
    if (!Number.isInteger(this.operatorChatId)) return;

    const now  = Date.now();
    const last = this.lastDmAt.get(kind) ?? 0;
    if (now - last < CorpBot.DM_COOLDOWN_MS) return;
    this.lastDmAt.set(kind, now);

    try {
      await this.tgBot.sendDm(this.operatorChatId, text, { parseMode: 'Markdown' });
    } catch {
      /* sendDm already swallows errors, this is just defence in depth */
    }
  }

  /** Call this once after construction. Returns false if no key configured. */
  async init(): Promise<boolean> {
    // Corps are permanently tied to the creating wallet — no ownership transfer exists.
    // Use MAIN_KEY (the game wallet) to sign all corp transactions.
    // BOT_PRIVATE_KEY is kept as a fallback alias in case the env var name changes.
    let rawKey = process.env.MAIN_KEY ?? process.env.BOT_PRIVATE_KEY ?? '';
    if (!rawKey) {
      logger.warn('[CorpBot] No signing key (MAIN_KEY / BOT_PRIVATE_KEY) — bot disabled');
      return false;
    }

    try {
      // Normalise: strip whitespace/quotes, drop any 0x prefixes
      const cleaned = rawKey
        .replace(/['"\s]/g, '')
        .replace(/^(0x)+/i, '');

      // Validate format BEFORE handing to ethers — its errors can echo
      // the bad key value back in err.message, which would then land in logs.
      if (!/^[a-fA-F0-9]{64}$/.test(cleaned)) {
        logger.error('[CorpBot] Invalid MAIN_KEY format (expected 64 hex chars)');
        return false;
      }

      // Use the raw wallet (no NonceManager). We had NonceManager wrapping
      // for parallel-write safety, but it caused desync bugs: when on-chain
      // nonces advanced via simultaneously-firing transactions, NonceManager's
      // local cache stayed behind, then subsequent txs failed with
      // NONCE_EXPIRED ("Expected >= 539, got 537"). Without NonceManager,
      // ethers fetches the next pending nonce from the RPC for each
      // sendTransaction. Slightly more RPC overhead but always correct.
      // The tick reentrancy guard already serializes our writes, so we
      // never have concurrent in-flight txs from this process.
      const wallet  = new ethers.Wallet('0x' + cleaned, this.provider);
      this.signer   = wallet;
      logger.info({ address: wallet.address }, '[CorpBot] Signer loaded');

      this.contracts = this.corps.map(addr =>
        new ethers.Contract(addr, CORP_ABI, wallet)
      );

      // Verify this key actually owns the corps
      let owned = 0;
      for (let i = 0; i < this.corps.length; i++) {
        const owner: string = await this.contracts[i].owner();
        if (owner.toLowerCase() === this.signer.address.toLowerCase()) owned++;
        else logger.warn({ corp: this.corps[i], owner }, '[CorpBot] Corp not owned by this key');
      }

      if (owned === 0) {
        logger.error('[CorpBot] This key owns 0 corps — check MAIN_KEY in .env');
        return false;
      }

      const bal = await this.provider.getBalance(this.signer.address);
      logger.info({ owned, eth: ethers.formatEther(bal) }, `[CorpBot] Ready — owns ${owned}/${this.corps.length} corps`);
      return true;
    } catch (err: any) {
      // Generic error only — never log err.message during init since ethers
      // can echo the offending key value back inside its error strings.
      logger.error({ errType: err?.code ?? err?.name ?? 'unknown' }, '[CorpBot] Init failed');
      return false;
    }
  }

  start() {
    if (this.running || !this.signer) return;
    this.running = true;
    // Immediate first tick, then every 30s. Each scheduled tick checks
    // tickInFlight and skips if a previous tick is still working.
    void this.runTick();
    this.timer = setInterval(() => { void this.runTick(); }, POLL_INTERVAL_MS);
    logger.info('[CorpBot] Started');
  }

  // ============================================================
  // Public control surface (used by /bot Telegram commands)
  // ============================================================

  /** Snapshot of bot state for `/bot` (status). */
  getStatus(): CorpBotStatus {
    // Pull latest wallet balances if a getter was wired in.
    let balances: CorpBotStatus['balances'] = null;
    if (this.getWalletBalances) {
      try {
        const wb = this.getWalletBalances();
        if (wb) {
          balances = {
            inf:        wb.inf,
            dirty:      wb.dirty,
            usdm:       wb.usdm,
            infPerHr:   wb.infPerHour,
            dirtyPerHr: wb.dirtyPerHour,
            usdmPerHr:  wb.usdmPerHour,
          };
        }
      } catch { /* getter is best-effort */ }
    }

    const hktHour = this.currentHKTHour();
    const schedulePreset = this.scheduleEnabled ? this.schedule[hktHour] : null;
    const now = Date.now();
    const tripped = now < this.circuitBreakerUntil;
    // Recompute distinct-count for the current window so /bot status shows live pressure
    const liveLiqs = this.recentLiqs.filter(l => now - l.ts < this.cbWindowMs);
    const distinct = new Set(liveLiqs.map(l => l.corp)).size;

    return {
      running:        this.running,
      paused:         this.paused,
      signer:         this.signer?.address ?? null,
      ownedCorps:     this.contracts.length,
      totalCorps:     this.corps.length,
      activePresetName:        this.activePresetName,
      targetModes:             [...this.targetModes],
      scheduleMode:            this.manualPresetName ? 'manual' : 'auto',
      scheduleEnabled:         this.scheduleEnabled,
      hktHour,
      schedulePresetThisHour:  schedulePreset,
      dangerHigh:     this.dangerHigh,
      dangerLow:      this.dangerLow,
      panicThreshold: this.panicThreshold,
      lastDanger:     this.lastDanger,
      inDangerState:  this.inDangerState,
      perCorp: this.lastCorpSnapshot.map(s => ({
        addr:     s.addr,
        auto:     s.auto,
        mode:     s.mode,
        modeName: MODE_NAMES[s.mode] ?? `mode${s.mode}`,
      })),
      recentLogs: [...this.logBuffer],
      circuitBreaker: {
        tripped,
        cooldownSecondsRemaining: tripped ? Math.ceil((this.circuitBreakerUntil - now) / 1000) : 0,
        recentLiquidationCount:   distinct,
        windowSeconds:            Math.round(this.cbWindowMs / 1000),
        threshold:                this.cbThreshold,
        totalTrips:               this.circuitBreakerTrips,
      },
      balances,
    };
  }

  /** List all available presets (for /bot preset list). */
  listPresets(): BotPreset[] {
    return Object.values(this.presets);
  }

  /** Get the schedule (for /bot schedule). Returns 24-element array, HKT hour → preset name. */
  getSchedule(): string[] { return [...this.schedule]; }

  /**
   * Lock the bot to a specific preset. Pass null/empty/'auto' to release back
   * to schedule mode.
   */
  setManualPreset(presetName: string | null): { ok: boolean; reason?: string } {
    if (!presetName || presetName.toLowerCase() === 'auto') {
      this.manualPresetName = null;
      this.lastSwitch.clear();
      this.record('info', '[CorpBot] Manual preset cleared — schedule resumed');
      void this.runTick();
      return { ok: true };
    }
    const key = presetName.toLowerCase();
    if (!this.presets[key]) {
      return { ok: false, reason: `unknown preset '${presetName}'. Try /bot preset list` };
    }
    this.manualPresetName = key;
    this.lastSwitch.clear(); // bypass debounce so the change applies immediately
    this.record('info', `[CorpBot] Manual preset → ${key}`);
    void this.runTick();
    return { ok: true };
  }

  /** Define or overwrite a custom preset by name. Extortion (mode 0) is
   *  explicitly disallowed per operator policy — it has only 0.039% liquidation
   *  tolerance and is considered too fragile to run. */
  setCustomPreset(name: string, modes: number[]): { ok: boolean; reason?: string } {
    const cleanName = name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!cleanName) return { ok: false, reason: 'name required' };
    if (modes.length !== this.corps.length) {
      return { ok: false, reason: `modes array must have ${this.corps.length} entries` };
    }
    if (modes.some(m => m !== 1 && m !== 2)) {
      return { ok: false, reason: 'each mode must be 1 (Arms) or 2 (Drug). Extortion disabled.' };
    }
    this.presets[cleanName] = { name: cleanName, modes: [...modes] };
    this.record('info', `[CorpBot] Custom preset '${cleanName}' = [${modes.join(',')}]`);
    return { ok: true };
  }

  /** Set the schedule entry for one or more HKT hours. */
  setScheduleHours(hours: number[], presetName: string): { ok: boolean; reason?: string } {
    const key = presetName.toLowerCase();
    if (!this.presets[key]) {
      return { ok: false, reason: `unknown preset '${presetName}'` };
    }
    for (const h of hours) {
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        return { ok: false, reason: `hour ${h} out of range (0-23)` };
      }
    }
    for (const h of hours) this.schedule[h] = key;
    this.record('info', `[CorpBot] Schedule updated: hours [${hours.join(',')}] → ${key}`);
    return { ok: true };
  }

  /** Toggle schedule on/off entirely. When off, bot uses 'all-drug' as default. */
  setScheduleEnabled(enabled: boolean) {
    this.scheduleEnabled = enabled;
    this.record('info', `[CorpBot] Schedule ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  /** Update the panic-mode danger threshold. */
  setPanicThreshold(threshold: number): { ok: boolean; reason?: string } {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      return { ok: false, reason: 'must be 0-100' };
    }
    this.panicThreshold = Math.round(threshold);
    this.record('info', `[CorpBot] Panic threshold = ${this.panicThreshold}`);
    return { ok: true };
  }

  /** Pause the bot — ticks still fetch state but submit no transactions. */
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.record('info', '[CorpBot] PAUSED by operator');
  }

  /** Resume after a pause. */
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.record('info', '[CorpBot] RESUMED by operator');
    // Kick a tick immediately so the resume is visible
    void this.runTick();
  }

  /**
   * Manually force ALL corps into a single mode. Extortion is rejected per
   * operator policy — 0.039% liq threshold makes it unsafe.
   */
  forceMode(mode: number): { ok: boolean; reason?: string } {
    if (mode === MODE_EXTORTION) {
      return { ok: false, reason: 'Extortion is disabled — only Arms (1) or Drug (2)' };
    }
    if (mode !== MODE_DRUG && mode !== MODE_ARMS) {
      return { ok: false, reason: 'mode must be 1 (Arms) or 2 (Drug)' };
    }
    const presetName = mode === MODE_DRUG ? 'all-drug' : 'all-arms';
    return this.setManualPreset(presetName);
  }

  /**
   * Force-claim rewards on all corps that have a pending claim. Returns the
   * list of tx hashes (and any errors) so the operator gets concrete feedback.
   */
  async forceClaim(): Promise<{ corp: string; tx?: string; reward?: number; error?: string }[]> {
    const results: { corp: string; tx?: string; reward?: number; error?: string }[] = [];
    if (!this.signer) {
      results.push({ corp: '-', error: 'no signer' });
      return results;
    }
    for (let i = 0; i < this.contracts.length; i++) {
      const c    = this.contracts[i];
      const addr = this.corps[i];
      try {
        const pending: boolean = await c.hasPendingClaim();
        if (!pending) {
          results.push({ corp: addr, error: 'no pending reward' });
          continue;
        }
        let reward = 0;
        try { reward = Number(ethers.formatEther(await c.pendingReward())); } catch {}
        const tx = await c.claimRewards();
        await tx.wait();
        this.record('info', `[CorpBot] FORCE CLAIM ${addr.slice(0, 10)}.. ${reward.toFixed(2)} DIRTY`);
        results.push({ corp: addr, tx: tx.hash, reward });
      } catch (err: any) {
        this.record('warn', `[CorpBot] FORCE CLAIM ${addr.slice(0, 10)}.. failed: ${err.message}`);
        results.push({ corp: addr, error: err?.shortMessage ?? err?.message ?? 'unknown' });
      }
    }
    return results;
  }

  /**
   * Update danger thresholds at runtime. Validates that high > low and both
   * are in [0, 100]. No effect if validation fails.
   */
  setThresholds(high: number, low: number): { ok: boolean; reason?: string } {
    if (!Number.isFinite(high) || !Number.isFinite(low)) {
      return { ok: false, reason: 'thresholds must be numbers' };
    }
    if (high < 0 || high > 100 || low < 0 || low > 100) {
      return { ok: false, reason: 'thresholds must be 0-100' };
    }
    if (high <= low) {
      return { ok: false, reason: 'high must be greater than low (else thresholds overlap)' };
    }
    this.dangerHigh = Math.round(high);
    this.dangerLow  = Math.round(low);
    this.record('info', `[CorpBot] Thresholds updated: HIGH=${this.dangerHigh} LOW=${this.dangerLow}`);
    return { ok: true };
  }

  /** Async-aware shutdown — waits up to 30s for the in-flight tick to settle. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.currentTick) {
      try {
        await Promise.race([
          this.currentTick,
          new Promise(resolve => setTimeout(resolve, 30_000)),
        ]);
      } catch {
        /* swallowed — tick errors are already logged by runTick() */
      }
    }
    this.running = false;
    logger.info('[CorpBot] Stopped');
  }

  /**
   * Tick wrapper that enforces the reentrancy guard. If a previous tick is
   * still working (e.g. because a tx is taking longer than 30s to confirm),
   * the new tick is skipped — which is what we want, the in-flight tick will
   * finish and the next scheduled tick picks up fresh state.
   */
  private async runTick(): Promise<void> {
    if (this.tickInFlight || this.stopping) return;
    this.tickInFlight = true;
    this.currentTick  = this.tick().catch(err => {
      logger.warn({ err: err?.message }, '[CorpBot] tick crashed');
    }).finally(() => {
      this.tickInFlight = false;
      this.currentTick  = null;
    });
    await this.currentTick;
  }

  /**
   * Called by the main loop with the current danger score. Just stores it —
   * the actual preset selection happens at tick() time using resolveActivePreset().
   * This decoupling lets the schedule + danger override + manual lock all
   * share the same evaluation path.
   */
  onDangerScore(score: number) {
    this.lastDanger = score;
  }

  private async tick() {
    if (!this.signer) return;
    const now = Date.now();
    // Fresh snapshot collected for /bot status — overwrites lastCorpSnapshot at end.
    const snapshot: { addr: string; auto: boolean; mode: number }[] = [];

    // Resolve which preset should be active right now (manual / danger / schedule).
    const { preset, label: presetLabel } = this.resolveActivePreset();
    this.activePresetName = presetLabel;
    this.targetModes      = [...preset.modes];
    this.targetPaused     = !!preset.paused;

    // If preset changed since last tick, DM the operator (rate-limited).
    if (this.lastNotifiedPreset !== presetLabel &&
        (now - this.lastPresetChangeAt) > CorpBot.PRESET_CHANGE_DM_COOLDOWN_MS) {
      this.lastNotifiedPreset = presetLabel;
      this.lastPresetChangeAt = now;
      const modesStr = preset.paused ? 'PAUSED'
        : preset.modes.map(m => MODE_NAMES[m] ?? '?').join(' / ');
      void this.notify(
        `🔄 *Preset switched: ${presetLabel}*\n` +
        `Modes: ${modesStr}\n` +
        `HKT hour: ${this.currentHKTHour()} | Danger: ${this.lastDanger ?? '?'}`,
        'preset-change'
      );
    }

    for (let i = 0; i < this.contracts.length; i++) {
      const contract = this.contracts[i];
      const addr = this.corps[i];
      const label = addr.slice(0, 10);
      const targetMode = this.targetModes[i] ?? MODE_DRUG;

      try {
        // --- Auto-claim ---
        // We always check for pending claims, even when paused or in danger
        // mode — claiming is non-controversial (it just receives DIRTY) and
        // the operator generally wants accumulated rewards collected.
        const pending = await contract.hasPendingClaim();
        if (pending && !this.paused) {
          this.record('info', `[CorpBot] Claiming ${label}..`);
          let rewardDirty = 0;
          try {
            const raw = await contract.pendingReward();
            rewardDirty = Number(ethers.formatEther(raw));
          } catch { /* not critical */ }
          const tx = await contract.claimRewards();
          await tx.wait();
          this.record('info', `[CorpBot] ✅ Claimed ${label}.. ${rewardDirty.toFixed(2)} DIRTY`);
          void this.notify(
            `💰 *Auto-claimed*\n` +
            `Corp: \`${label}\`\n` +
            `Reward: *${rewardDirty.toFixed(2)} DIRTY*\n` +
            `[tx](https://www.megaexplorer.xyz/tx/${tx.hash})`,
            `claim:${addr}`
          );
        }

        // --- Read current state (single batch) ---
        const [autoOn, curModeRaw, isActive, isCompletable, cooldownEndRaw] = await Promise.all([
          contract.autoTradeEnabled(),
          contract.autoTradeMode(),
          contract.isTradeActive(),
          contract.isCompletable(),
          contract.getCooldownEnd(),
        ]);
        const curMode = Number(curModeRaw);
        const cooldownEnd = Number(cooldownEndRaw);
        const nowSec = Math.floor(now / 1000);
        const cooldownPassed = cooldownEnd === 0 || cooldownEnd <= nowSec;
        snapshot.push({ addr, auto: autoOn, mode: curMode });

        // Operator-pause flag (legacy /bot pause) — observe only.
        if (this.paused) continue;

        const lastSw  = this.lastSwitch.get(addr) ?? 0;
        const cooledDown = (now - lastSw) > MODE_SWITCH_COOLDOWN_MS;

        // --- Finalize a completable trade (triggers contract auto-restart) ---
        // Without this call, a finished trade stays finished and the next op
        // never auto-starts. The contract relies on someone calling completeTrade.
        if (isCompletable) {
          this.record('info', `[CorpBot] Completing finished trade ${label}..`);
          const tx = await contract.completeTrade();
          await tx.wait();
          this.record('info', `[CorpBot] ✅ Trade completed ${label}.. (auto-restart should kick in)`);
        }

        // --- Apply target state ---
        if (this.targetPaused) {
          // Paused preset — disable auto-trade if it's currently on. Saves INF
          // in dead-zone hours where every op fails.
          if (autoOn && cooledDown) {
            this.record('info', `[CorpBot] Disabling auto-trade ${label}.. (paused preset)`);
            const tx = await contract.disableAutoTrade();
            await tx.wait();
            this.lastSwitch.set(addr, now);
            this.record('info', `[CorpBot] ✅ Auto-trade disabled ${label}..`);
            const snapEntry = snapshot.find(s => s.addr === addr);
            if (snapEntry) snapEntry.auto = false;
          }
          continue;
        }

        // Track whether we should attempt the bootstrap startTrade after this
        // block. Set true if either (a) auto was already on, or (b) we just
        // enabled it — both cases need an explicit startTrade if the corp
        // is idle. Without this, fresh corps stayed at auto=enabled+idle
        // because we'd `continue` and the next tick (30s later) was racing
        // against the schedule re-disabling them.
        let needBootstrap = false;

        if (!autoOn) {
          // Auto-trade is off — turn it back on in target mode
          this.record('info', `[CorpBot] Re-enabling auto-trade ${label}.. → ${MODE_NAMES[targetMode]}`);
          const tx = await contract.enableAutoTrade(targetMode);
          await tx.wait();
          this.lastSwitch.set(addr, now);
          this.record('info', `[CorpBot] ✅ Auto-trade re-enabled ${label}..`);
          void this.notify(
            `🔁 *Auto-trade re-enabled*\n` +
            `Corp: \`${label}\`\n` +
            `Mode: *${MODE_NAMES[targetMode]}*\n` +
            `[tx](https://www.megaexplorer.xyz/tx/${tx.hash})`,
            `reenable:${addr}`
          );
          // Fall through to the bootstrap-startTrade check — same tick.
          needBootstrap = !isActive && cooldownPassed;
          // Update snapshot to reflect the new auto state
          const snapEntry = snapshot.find(s => s.addr === addr);
          if (snapEntry) snapEntry.auto = true;
        } else {
          needBootstrap = !isActive && cooldownPassed && cooledDown;
        }

        // --- Bootstrap idle corps ---
        // If auto-trade is on but isActive=false and the cooldown is elapsed (or
        // never set), the contract will NOT auto-start a trade on its own —
        // we have to call startTrade(mode) explicitly. This catches:
        //   • Newly-activated L2/L3 corps that have never traded
        //   • Corps where auto-restart got "stuck" after a previous trade
        //   • Anything where state shows idle+auto+no-cooldown
        if (needBootstrap) {
          this.record('info',
            `[CorpBot] Bootstrap startTrade ${label}.. mode=${MODE_NAMES[targetMode]} (cooldownEnd=${cooldownEnd})`);
          try {
            const tx = await contract.startTrade(targetMode);
            await tx.wait();
            this.lastSwitch.set(addr, now);
            this.record('info', `[CorpBot] ✅ Manually started trade ${label}.. → ${MODE_NAMES[targetMode]}`);
            void this.notify(
              `▶️ *Trade started*\n` +
              `Corp: \`${label}\`\n` +
              `Mode: *${MODE_NAMES[targetMode]}*\n` +
              `(corp was idle with auto-trade on but never running — manually kicked off)\n` +
              `[tx](https://www.megaexplorer.xyz/tx/${tx.hash})`,
              `start:${addr}`
            );
          } catch (err: any) {
            // startTrade can fail if the corp already has an active trade
            // (race condition) or insufficient INF. Log and move on.
            this.record('warn',
              `[CorpBot] startTrade failed ${label}..: ${err.shortMessage ?? err.message}`);
          }
          continue;
        }

        if (curMode !== targetMode && cooledDown) {
          // Mode mismatch and cooldown passed — switch
          const fromName = MODE_NAMES[curMode] ?? `mode${curMode}`;
          const toName   = MODE_NAMES[targetMode] ?? `mode${targetMode}`;
          this.record('info', `[CorpBot] Switching ${label}.. ${fromName} → ${toName}`);
          const tx = await contract.enableAutoTrade(targetMode);
          await tx.wait();
          this.lastSwitch.set(addr, now);
          this.record('info', `[CorpBot] ✅ Switched ${label}.. → ${toName}`);
          const snapEntry = snapshot.find(s => s.addr === addr);
          if (snapEntry) snapEntry.mode = targetMode;
          void this.notify(
            `⚙️ *Mode switched: ${fromName} → ${toName}*\n` +
            `Corp: \`${label}\`\n` +
            `[tx](https://www.megaexplorer.xyz/tx/${tx.hash})`,
            `switch:${addr}`
          );
        }
      } catch (err: any) {
        this.record('warn', `[CorpBot] tick error ${label}..: ${err.message}`, { corp: label });
      }
    }

    // Replace the cached snapshot atomically once the tick completes.
    if (snapshot.length > 0) this.lastCorpSnapshot = snapshot;
  }
}
