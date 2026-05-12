// ============================================================
// WhaleOutcomeTracker — rolling outcome signal from top-SR wallets.
//
// What this is and isn't:
//   • Not a copy executor. WhaleCopyFeed already detects START transitions
//     (idle→active) and queues them for our bot. This module is the dual
//     observer — it detects FINISH transitions (active→idle, and whether
//     the corp is completable [success] or liquidated [failure]).
//   • Not a leaderboard. Ranking lives in LoadoutScannerFeed (which we
//     reuse to get the pool of wallets to track).
//   • A rolling 2h success-rate aggregator that classifies the signal as
//     green / yellow / orange / red and emits a danger modifier. Read
//     by CorpBot.getEffectiveDanger() (shadow-mode-first).
//
// How transition detection works:
//   Multicall3 batch every POLL_MS (60s default). For each tracked corp
//   we read (isTradeActive, isCompletable, autoTradeMode). Compare to
//   the previous snapshot:
//
//     prev.isActive=true  →  now.isActive=false
//       and now.isCompletable=true   ⇒  SUCCESS (op finished; whale will claim)
//       and now.isCompletable=false  ⇒  LIQUIDATION (TL fired; cooldown began)
//
//   The MODE for the outcome is taken from the PREVIOUS snapshot's
//   autoTradeMode — the mode the corp was running while active. Reading
//   it post-liquidation can race (the whale may have flipped mode before
//   our next poll).
//
//   On the very first observation of a corp, prev is undefined and we
//   don't emit — we just seed the state. Restart-warmup is handled by
//   loading recent whale_outcomes rows from the DB (so a process bounce
//   doesn't wipe the rolling SR window).
//
// Staggering:
//   WhaleCopyFeed polls at the natural :00 / :30 cadence (30s interval
//   anchored at start). We deliberately wait 15s after startup before
//   our first poll, so our 60s cadence lands on :15 / :15 — never the
//   same second as the copy feed. Same Multicall3 endpoint, but the
//   batched call sizes don't overlap.
// ============================================================

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { logger } from '../logger';
import type { LoadoutScannerFeed } from './loadout-scanner';
import type { Storage } from '../storage/db';

const RPC          = 'https://mainnet.megaeth.com/rpc';
const MULTICALL3   = '0xca11bde05977b3631167028862be2a173976ca11';
const USER_FACTORY = '0x619814a203ca441611cee02abf31986ca265dd35';

const FACTORY_ABI = [
  'function getUserCompanies(address) view returns (address[])',
];
const CORP_ABI = [
  'function isTradeActive() view returns (bool)',
  'function isCompletable() view returns (bool)',
  'function autoTradeMode() view returns (uint8)',
];
const MC3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[]) external view returns ((bool success, bytes returnData)[])',
];

const POOL_REFRESH_MS    = 15 * 60_000;   // re-rank pool every 15min
const CORPS_REFRESH_MS   = 30 * 60_000;   // re-fetch each whale's corp list every 30min
const STARTUP_STAGGER_MS = 15_000;        // wait 15s after start to offset from WhaleCopyFeed
const CONFIDENCE_LOG_MS  = 5 * 60_000;    // periodic DB log cadence

export type WhaleOutcomeMode = 'drug' | 'arms' | 'extortion';
export type WhaleSignal = 'green' | 'yellow' | 'orange' | 'red';

export interface WhaleOutcome {
  wallet: string;
  corp: string;
  mode: WhaleOutcomeMode;
  success: boolean;
  detectedAt: number;
}

export interface WhaleConfidenceWallet {
  wallet: string;
  ops2h: number;
  sr2h: number;
  currentActiveOps: number;
}

export interface WhaleConfidenceAggregate {
  totalOps2h: number;
  totalSuccesses2h: number;
  sr2h: number;
  activeDrugOps: number;
  activeArmsOps: number;
  activeExtOps: number;
}

export interface WhaleConfidence {
  perWallet: WhaleConfidenceWallet[];
  aggregate: WhaleConfidenceAggregate;
  signal: WhaleSignal;
  /** Negative reduces our effective danger; positive increases it. */
  dangerModifier: number;
  /** True when shadow mode is active and the modifier is logged-only. */
  shadow: boolean;
  /** True when totalOps2h >= minOps so the signal is "live data" not the default-yellow no-signal. */
  hasSignal: boolean;
  trackedWallets: number;
  trackedCorps: number;
  /** Threshold for `hasSignal` — surfaced so the UI doesn't hardcode a value. */
  minOps: number;
  /** Corps the tracker WANTED to read but couldn't fit in this tick's
   *  Multicall3 batch. 0 in normal operation; >0 indicates pool overflow
   *  the batcher should have split (Codex audit #3). */
  droppedCorps: number;
  lastUpdate: number;
}

export interface WhaleOutcomeTrackerConfig {
  loadoutScanner: LoadoutScannerFeed;
  storage: Storage;
  shadow: boolean;
  disabled: boolean;
  greenSr: number;
  yellowSr: number;
  orangeSr: number;
  greenMod: number;
  orangeMod: number;
  redMod: number;
  minOps: number;
  windowMs: number;
  pollMs: number;
  poolSize: number;
  minPoolOps: number;
  /** Optional enrichment hook — when wired, the tracker writes
   *  effective_danger + target_corps onto each whale_confidence_log row
   *  so the offline counterfactual analysis can join the signal to what
   *  graduated actually decided. Wired from index.ts where the corp-bot
   *  accessors are in scope. Codex audit fix #7. */
  getEnrichment?: () => { effectiveDanger: number; targetCorps: number } | null;
}

interface WhaleCorpSnapshot {
  corp: string;
  wallet: string;
  isActive: boolean;
  isCompletable: boolean;
  mode: number;
}

interface PoolEntry {
  wallet: string;
  corps: string[];
  corpsRefreshedAt: number;
  /** SR from the LoadoutScanner topBySr 28h window — used for display only. */
  rankSr: number;
  rankOps: number;
}

function modeToString(mode: number): WhaleOutcomeMode {
  if (mode === 2) return 'drug';
  if (mode === 1) return 'arms';
  return 'extortion';
}

export class WhaleOutcomeTracker extends EventEmitter {
  private readonly cfg: WhaleOutcomeTrackerConfig;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly corpIface: ethers.Interface;
  private readonly factory: ethers.Contract;
  private readonly mc3: ethers.Contract;

  private pool: PoolEntry[] = [];
  private lastPoolRefreshAt = 0;

  /** Per-corp last-known snapshot, used to detect transitions. */
  private corpStates = new Map<string, WhaleCorpSnapshot>();

  /** Ring buffer of detected outcomes (rolling 2h window via filtering). */
  private outcomes: WhaleOutcome[] = [];
  private readonly MAX_OUTCOMES = 1000;

  /** Pending transitions awaiting event-backed classification from
   *  op_outcomes. Codex audit fix #1: the isCompletable heuristic can
   *  misclassify when the whale's bot completes between polls. We defer
   *  classification, retry next tick, and fall back to the heuristic
   *  only when op-scraper hasn't caught up after CLASSIFY_TIMEOUT_MS. */
  private pendingTransitions: Array<{
    wallet: string;
    corp: string;
    prevMode: number;
    detectedAt: number;
    /** From the snapshot AT the moment we detected the transition. */
    fallbackSuccess: boolean;
  }> = [];
  private readonly CLASSIFY_TIMEOUT_MS = 4 * 60_000;
  /** How far back to look in op_outcomes when matching a transition. We
   *  give the scraper plenty of slack — TC and TL fire on chain at op
   *  completion, scraper polls every block, so it's usually within seconds
   *  but can lag during heavy network activity. */
  private readonly CLASSIFY_LOOKBACK_MS = 10 * 60_000;
  /** Multicall3 has a soft cap around 120-150 calls depending on weight.
   *  We split into batches of this many corps (×3 reads = 60 calls) so
   *  even a large pool of PL3 whales (9 corps each) fits comfortably. */
  private readonly MC3_CORPS_PER_BATCH = 20;

  private confidence: WhaleConfidence | null = null;
  /** Most recently EMITTED signal — only updated after dwell-time
   *  confirmation. lastObservedSignal is the per-tick raw value.
   *  Codex audit fix #6. */
  private lastEmittedSignal: WhaleSignal | null = null;
  private lastObservedSignal: WhaleSignal | null = null;
  private pendingSignal: WhaleSignal | null = null;
  private pendingSignalSince: number = 0;
  /** Minimum dwell — the new signal must persist this long before we
   *  emit signal-change. With 60s polls + 90s dwell, a fresh signal
   *  fires after the 2nd consecutive poll at the new level (no flap). */
  private readonly SIGNAL_DWELL_MS = 90_000;
  private lastConfidenceLogAt = 0;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private startupDelayTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(cfg: WhaleOutcomeTrackerConfig) {
    super();
    this.cfg = cfg;
    this.provider  = new ethers.JsonRpcProvider(RPC);
    this.corpIface = new ethers.Interface(CORP_ABI);
    this.factory   = new ethers.Contract(USER_FACTORY, FACTORY_ABI, this.provider);
    this.mc3       = new ethers.Contract(MULTICALL3, MC3_ABI, this.provider);
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.cfg.disabled) {
      logger.info('[WhaleOutcome] disabled via config');
      return;
    }
    this.running = true;

    // Warm the rolling window from DB so a restart doesn't wipe the
    // 2h-SR estimate. We trust the existing rows — duplicate detection
    // is handled by the corpStates seeding below.
    try {
      const rows = this.cfg.storage.getRecentWhaleOutcomes(this.cfg.windowMs, this.MAX_OUTCOMES);
      for (const r of rows) {
        this.outcomes.push({
          wallet: r.wallet,
          corp: r.corp,
          mode: r.mode,
          success: !!r.success,
          detectedAt: r.ts,
        });
      }
      if (rows.length > 0) {
        logger.info({ warmed: rows.length }, '[WhaleOutcome] warmed rolling window from DB');
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, '[WhaleOutcome] DB warm failed (non-fatal)');
    }

    // Stagger first poll so we don't compete with WhaleCopyFeed.
    this.startupDelayTimer = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => { void this.tick(); }, this.cfg.pollMs);
    }, STARTUP_STAGGER_MS);

    logger.info({
      shadow: this.cfg.shadow,
      pollMs: this.cfg.pollMs,
      windowH: (this.cfg.windowMs / 3600_000).toFixed(1),
      thresholds: `g=${this.cfg.greenSr} y=${this.cfg.yellowSr} o=${this.cfg.orangeSr}`,
      modifiers: `g=${this.cfg.greenMod} o=${this.cfg.orangeMod} r=${this.cfg.redMod}`,
    }, '[WhaleOutcome] started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.startupDelayTimer) { clearTimeout(this.startupDelayTimer); this.startupDelayTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    logger.info('[WhaleOutcome] stopped');
  }

  /** Public read. Returns null until first poll completes. */
  getConfidence(): WhaleConfidence | null { return this.confidence; }

  /** Last N detected outcomes (newest first). Used by the dashboard ticker. */
  getRecentOutcomes(limit = 20): WhaleOutcome[] {
    return this.outcomes.slice(-limit).reverse();
  }

  /** Pool snapshot for ops-tab display. */
  getPoolSnapshot(): { wallet: string; corps: number; rankSr: number; rankOps: number }[] {
    return this.pool.map(p => ({
      wallet: p.wallet,
      corps: p.corps.length,
      rankSr: p.rankSr,
      rankOps: p.rankOps,
    }));
  }

  // ── internal ─────────────────────────────────────────────────

  private async refreshPool(): Promise<void> {
    const snap = this.cfg.loadoutScanner.getSnapshot();
    const topBySr = snap.topBySr ?? [];
    if (topBySr.length === 0) return;

    const eligible = topBySr
      .filter(r => r.opsCount >= this.cfg.minPoolOps)
      .slice(0, this.cfg.poolSize);

    const now = Date.now();
    const next: PoolEntry[] = [];
    for (const r of eligible) {
      const addr = r.address.toLowerCase();
      const existing = this.pool.find(p => p.wallet === addr);
      const stale = !existing || (now - existing.corpsRefreshedAt) > CORPS_REFRESH_MS;
      let corps: string[];
      let corpsRefreshedAt: number;
      if (stale) {
        try {
          const raw: string[] = await this.factory.getUserCompanies(addr);
          corps = raw
            .map(c => c.toLowerCase())
            .filter(c => c !== ethers.ZeroAddress.toLowerCase());
          corpsRefreshedAt = now;
        } catch (err: any) {
          logger.warn(
            { whale: addr.slice(0, 10), err: err.message },
            '[WhaleOutcome] getUserCompanies failed — using prior list',
          );
          corps = existing?.corps ?? [];
          corpsRefreshedAt = existing?.corpsRefreshedAt ?? 0;
        }
      } else {
        corps = existing!.corps;
        corpsRefreshedAt = existing!.corpsRefreshedAt;
      }
      next.push({
        wallet: addr,
        corps,
        corpsRefreshedAt,
        rankSr: r.successRate,
        rankOps: r.opsCount,
      });
    }

    // Forget transition state for corps that left the pool — otherwise
    // a removed whale rejoining could spuriously trigger an outcome on
    // a stale snapshot. Same defensive pattern as WhaleCopyFeed.
    const liveCorps = new Set(next.flatMap(p => p.corps));
    for (const c of [...this.corpStates.keys()]) {
      if (!liveCorps.has(c)) this.corpStates.delete(c);
    }

    this.pool = next;
    this.lastPoolRefreshAt = now;
    logger.info({
      pool: this.pool.length,
      totalCorps: liveCorps.size,
      whales: this.pool.map(p => `${p.wallet.slice(0, 10)}@${(p.rankSr * 100).toFixed(0)}%`).join(','),
    }, '[WhaleOutcome] pool refreshed');
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    if (Date.now() - this.lastPoolRefreshAt > POOL_REFRESH_MS) {
      try { await this.refreshPool(); }
      catch (err: any) { logger.warn({ err: err.message }, '[WhaleOutcome] pool refresh failed'); }
    }
    if (this.pool.length === 0) {
      try { await this.refreshPool(); }
      catch { /* tolerate */ }
      if (this.pool.length === 0) return;
    }

    const corps = this.pool.flatMap(p => p.corps.map(c => ({ wallet: p.wallet, corp: c })));
    if (corps.length === 0) {
      // Codex audit fix #4: still update confidence so warmed-from-DB
      // outcomes get a fresh snapshot + log entry, otherwise the signal
      // sits stale until a corp refresh succeeds.
      this.tryResolvePendingTransitions();
      const cutoff0 = Date.now() - this.cfg.windowMs;
      while (this.outcomes.length > 0 && this.outcomes[0].detectedAt < cutoff0) this.outcomes.shift();
      this.computeConfidence(0, 0);
      this.maybeLogConfidence();
      return;
    }

    // Codex audit fix #3: split corps into batches of MC3_CORPS_PER_BATCH
    // (×3 reads = 60 calls/batch, well under Multicall3's ~120 ceiling).
    // No truncation — every corp in the pool gets read every tick.
    type CorpReadResult = {
      wallet: string;
      corp: string;
      isActive: boolean;
      isCompletable: boolean;
      mode: number;
    };
    const readings: CorpReadResult[] = [];
    let droppedCorps = 0;
    for (let b = 0; b < corps.length; b += this.MC3_CORPS_PER_BATCH) {
      const batch = corps.slice(b, b + this.MC3_CORPS_PER_BATCH);
      const calls: any[] = [];
      for (const { corp } of batch) {
        calls.push({ target: corp, allowFailure: true, callData: this.corpIface.encodeFunctionData('isTradeActive',  []) });
        calls.push({ target: corp, allowFailure: true, callData: this.corpIface.encodeFunctionData('isCompletable', []) });
        calls.push({ target: corp, allowFailure: true, callData: this.corpIface.encodeFunctionData('autoTradeMode', []) });
      }
      let res: { success: boolean; returnData: string }[];
      try {
        res = await this.mc3.aggregate3.staticCall(calls);
      } catch (err: any) {
        logger.warn({ err: err.message, batchSize: batch.length, batchStart: b },
          '[WhaleOutcome] multicall batch failed; skipping this batch');
        droppedCorps += batch.length;
        continue;
      }
      for (let i = 0; i < batch.length; i++) {
        const { wallet, corp } = batch[i];
        const aRes = res[i * 3 + 0];
        const cRes = res[i * 3 + 1];
        const mRes = res[i * 3 + 2];
        if (!aRes?.success || !cRes?.success || !mRes?.success) { droppedCorps += 1; continue; }
        try {
          const isActive      = this.corpIface.decodeFunctionResult('isTradeActive',  aRes.returnData)[0] as boolean;
          const isCompletable = this.corpIface.decodeFunctionResult('isCompletable',  cRes.returnData)[0] as boolean;
          const mode          = Number(this.corpIface.decodeFunctionResult('autoTradeMode', mRes.returnData)[0]);
          readings.push({ wallet, corp, isActive, isCompletable, mode });
        } catch { droppedCorps += 1; }
      }
    }

    const now = Date.now();
    for (const r of readings) {
      const prev = this.corpStates.get(r.corp);
      const nextSnap: WhaleCorpSnapshot = {
        corp: r.corp, wallet: r.wallet, isActive: r.isActive,
        isCompletable: r.isCompletable, mode: r.mode,
      };
      // Transition: was active, now not active. Defer classification
      // until op-scraper publishes the TC/TL row (Codex audit fix #1):
      // queue here, resolve below from op_outcomes.
      if (prev && prev.isActive && !r.isActive) {
        this.pendingTransitions.push({
          wallet: r.wallet,
          corp: r.corp,
          prevMode: prev.mode,
          detectedAt: now,
          // Snapshot the heuristic at transition time, used as a
          // fallback when the scraper times out.
          fallbackSuccess: r.isCompletable || prev.isCompletable === true,
        });
      }
      this.corpStates.set(r.corp, nextSnap);
    }

    // Resolve pending transitions against op_outcomes — every tick — so
    // late-arriving rows still get accurate classification.
    this.tryResolvePendingTransitions();

    // Drop stale outcomes outside the rolling window before computing.
    const cutoff = now - this.cfg.windowMs;
    while (this.outcomes.length > 0 && this.outcomes[0].detectedAt < cutoff) {
      this.outcomes.shift();
    }

    this.computeConfidence(readings.length, droppedCorps);
    this.maybeLogConfidence();
  }

  /**
   * For every pending transition, try to find the matching TC/TL row in
   * `op_outcomes` and emit the classified outcome. Falls back to the
   * heuristic-at-transition-time snapshot after CLASSIFY_TIMEOUT_MS so a
   * permanently-missing scraper row doesn't leak the pending list.
   * Codex audit fix #1 + #5 (event-backed op_type wins over racy
   * autoTradeMode snapshot).
   */
  private tryResolvePendingTransitions(): void {
    if (this.pendingTransitions.length === 0) return;
    const now = Date.now();
    const stillPending: typeof this.pendingTransitions = [];
    for (const p of this.pendingTransitions) {
      const row = this.cfg.storage.getRecentOutcomeForCorp(p.corp, this.CLASSIFY_LOOKBACK_MS);
      // We only accept a row that's NEWER than the previous-corp-poll
      // baseline (op-scraper.ts cursor lag means a row from before the
      // transition could leak in if the corp ran two ops in a row).
      // p.detectedAt is the tick when we saw active→inactive; the TC/TL
      // event is committed before that, so we require:
      //   row.ts >= p.detectedAt - 2 * pollMs (a small slack window)
      const slackMs = 2 * this.cfg.pollMs;
      if (row && row.ts >= p.detectedAt - slackMs) {
        const success = row.succeeded === 1;
        const opMode: WhaleOutcomeMode = row.opType;
        this.appendOutcome({
          wallet: p.wallet, corp: p.corp,
          mode: opMode, success, detectedAt: p.detectedAt,
        });
        continue;
      }
      // No event row yet — wait, unless we've waited too long.
      if (now - p.detectedAt < this.CLASSIFY_TIMEOUT_MS) {
        stillPending.push(p);
        continue;
      }
      // Fallback: scraper didn't catch the event in time, use the
      // heuristic snapshot we took at transition time + best-guess mode
      // (whale's autoTradeMode at the moment they went inactive).
      this.appendOutcome({
        wallet: p.wallet, corp: p.corp,
        mode: modeToString(p.prevMode),
        success: p.fallbackSuccess,
        detectedAt: p.detectedAt,
      });
      logger.warn({
        corp: p.corp.slice(0, 10),
        ageS: Math.round((now - p.detectedAt) / 1000),
        fallback: p.fallbackSuccess,
      }, '[WhaleOutcome] classify timeout — using heuristic fallback');
    }
    this.pendingTransitions = stillPending;
  }

  /** Common append path for both event-backed and fallback outcomes. */
  private appendOutcome(o: WhaleOutcome): void {
    this.outcomes.push(o);
    if (this.outcomes.length > this.MAX_OUTCOMES) this.outcomes.shift();
    try {
      this.cfg.storage.insertWhaleOutcome({
        ts: o.detectedAt,
        wallet: o.wallet,
        corp: o.corp,
        mode: o.mode,
        success: o.success ? 1 : 0,
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, '[WhaleOutcome] insertWhaleOutcome failed (non-fatal)');
    }
    this.emit('whale-outcome', o);
  }

  private computeConfidence(trackedCorps: number, droppedCorps: number): void {
    const wallets = this.pool.map(p => p.wallet);
    // Codex audit fix #2: aggregate is scoped to the CURRENT pool so a
    // wallet that fell out of the top stops polluting the signal. Both
    // the per-wallet rows and the aggregate denominator use the same
    // set. Outcomes from dropped wallets stay in the rolling buffer
    // (they'll age out at windowMs) but are excluded from the signal.
    const poolSet = new Set(wallets);
    const cutoff = Date.now() - this.cfg.windowMs;
    const windowOutcomes = this.outcomes.filter(o => o.detectedAt > cutoff && poolSet.has(o.wallet));

    const perWallet: WhaleConfidenceWallet[] = wallets.map(wallet => {
      const wOutcomes = windowOutcomes.filter(o => o.wallet === wallet);
      const wCorps = [...this.corpStates.values()].filter(s => s.wallet === wallet);
      const wins = wOutcomes.filter(o => o.success).length;
      return {
        wallet,
        ops2h: wOutcomes.length,
        sr2h: wOutcomes.length > 0 ? wins / wOutcomes.length : 0,
        currentActiveOps: wCorps.filter(s => s.isActive).length,
      };
    });

    const totalOps = windowOutcomes.length;
    const totalSuccesses = windowOutcomes.filter(o => o.success).length;
    const sr = totalOps > 0 ? totalSuccesses / totalOps : 0;

    const liveStates = [...this.corpStates.values()];
    const activeDrug = liveStates.filter(s => s.isActive && s.mode === 2).length;
    const activeArms = liveStates.filter(s => s.isActive && s.mode === 1).length;
    const activeExt  = liveStates.filter(s => s.isActive && s.mode === 0).length;

    // Classification
    let signal: WhaleSignal;
    let dangerModifier: number;
    const hasSignal = totalOps >= this.cfg.minOps;
    if (!hasSignal) {
      signal = 'yellow';
      dangerModifier = 0;
    } else if (sr >= this.cfg.greenSr) {
      signal = 'green';
      dangerModifier = this.cfg.greenMod;
    } else if (sr >= this.cfg.yellowSr) {
      signal = 'yellow';
      dangerModifier = 0;
    } else if (sr >= this.cfg.orangeSr) {
      signal = 'orange';
      dangerModifier = this.cfg.orangeMod;
    } else {
      signal = 'red';
      dangerModifier = this.cfg.redMod;
    }

    this.confidence = {
      perWallet,
      aggregate: {
        totalOps2h: totalOps,
        totalSuccesses2h: totalSuccesses,
        sr2h: sr,
        activeDrugOps: activeDrug,
        activeArmsOps: activeArms,
        activeExtOps:  activeExt,
      },
      signal,
      dangerModifier,
      shadow: this.cfg.shadow,
      hasSignal,
      trackedWallets: this.pool.length,
      trackedCorps,
      minOps: this.cfg.minOps,   // Codex audit fix #8 (surface threshold to UI)
      droppedCorps,              // Codex audit fix #3 (observability)
      lastUpdate: Date.now(),
    };

    // Dwell-time gate (Codex audit fix #6): only emit signal-change once
    // the new signal has persisted across at least one full poll cycle.
    // Mechanism:
    //   - First time we see a new signal, mark it pending + start timer.
    //   - If the next observation matches AND dwell elapsed, emit.
    //   - If observation flips again before dwell elapses, reset.
    // Initial signal (no prior emitted) emits immediately so the first
    // boot-up DM isn't artificially delayed.
    const now = Date.now();
    if (this.lastEmittedSignal === null) {
      // Fresh start — set the baseline without emitting.
      this.lastEmittedSignal = signal;
    } else if (signal !== this.lastEmittedSignal) {
      if (this.pendingSignal === signal) {
        if (now - this.pendingSignalSince >= this.SIGNAL_DWELL_MS) {
          this.emit('signal-change', {
            from: this.lastEmittedSignal,
            to: signal,
            sr,
            totalOps,
            shadow: this.cfg.shadow,
          });
          this.persistConfidence(/*forcedTransition=*/true);
          this.lastEmittedSignal = signal;
          this.pendingSignal = null;
          this.pendingSignalSince = 0;
        }
      } else {
        // New pending direction — start the dwell clock.
        this.pendingSignal = signal;
        this.pendingSignalSince = now;
      }
    } else {
      // Observation matches emitted signal — clear any in-flight pending.
      this.pendingSignal = null;
      this.pendingSignalSince = 0;
    }
    this.lastObservedSignal = signal;
    this.emit('confidence', this.confidence);
  }

  /** Periodic + transition-triggered DB log. effectiveDanger + targetCorps
   *  are nullable here — they're attached upstream via the api/server
   *  wiring which knows the corp-bot, but this module doesn't. We log
   *  what we know; the upstream `effective_danger` enrichment is wired
   *  separately. */
  private maybeLogConfidence(): void {
    if (Date.now() - this.lastConfidenceLogAt < CONFIDENCE_LOG_MS) return;
    this.persistConfidence(false);
  }

  private persistConfidence(_forcedTransition: boolean): void {
    if (!this.confidence) return;
    let enrichment: { effectiveDanger: number; targetCorps: number } | null = null;
    if (this.cfg.getEnrichment) {
      try { enrichment = this.cfg.getEnrichment(); }
      catch (err: any) {
        logger.debug({ err: err.message }, '[WhaleOutcome] enrichment hook threw');
      }
    }
    try {
      this.cfg.storage.insertWhaleConfidence({
        ts: this.confidence.lastUpdate,
        tracked_wallets: this.confidence.trackedWallets,
        tracked_corps: this.confidence.trackedCorps,
        total_ops_2h: this.confidence.aggregate.totalOps2h,
        total_successes_2h: this.confidence.aggregate.totalSuccesses2h,
        sr_2h: this.confidence.aggregate.sr2h,
        active_drug_ops: this.confidence.aggregate.activeDrugOps,
        active_arms_ops: this.confidence.aggregate.activeArmsOps,
        signal: this.confidence.signal,
        danger_modifier: this.confidence.dangerModifier,
        effective_danger: enrichment?.effectiveDanger ?? null,
        target_corps:     enrichment?.targetCorps     ?? null,
      });
      this.lastConfidenceLogAt = Date.now();
    } catch (err: any) {
      logger.warn({ err: err.message }, '[WhaleOutcome] insertWhaleConfidence failed');
    }
  }
}
