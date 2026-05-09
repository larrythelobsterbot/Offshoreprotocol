// ============================================================
// WhaleCopyFeed — copy-trading the network's stable top-SR wallets.
//
// Architecture:
//   1. Every COPY_POOL_REFRESH_MS, re-rank the pool: top N wallets by
//      72h SR with min ops + min SR thresholds. We re-use
//      LoadoutScannerFeed's `topBySr` (refreshed every 15min via the
//      network scan) so we don't double-scan the chain. If `topBySr`
//      is empty (early boot), the feed sits idle until the scanner
//      publishes one.
//
//   2. Every COPY_POLL_MS, multicall each pool whale's corps via
//      Multicall3 — reading `(isTradeActive, autoTradeMode, getCooldownEnd)`
//      per corp. We compare against the previous snapshot and detect
//      transitions:
//          isTradeActive: false → true   ⇒  whale just bootstrapped an op
//      That's the copy event: emit { whale, mode, ts, sourceCorp }.
//
//   3. We DO NOT execute the copy ourselves. CorpBot consumes the
//      event queue and decides whether to bootstrap one of OUR free
//      corps in the same mode (copy-mode preset).
//
// Why detect via isTradeActive transitions and not via TradeStarted
// event subscriptions? The contract emits Transfer/TradeStarted only
// after `startTrade` mines, and we'd need a websocket subscription
// that's reliable through MegaETH's RPC quirks. Polling state is
// simpler and aligns with our 30s cadence — we miss the first ~15s
// of the whale's op, but our copies start within 30s of theirs which
// is well inside the operation window (Drug 90min / Arms 30min).
// ============================================================

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { logger } from '../logger';
import type { LoadoutScannerFeed } from './loadout-scanner';

const RPC = 'https://mainnet.megaeth.com/rpc';
const MULTICALL3   = '0xca11bde05977b3631167028862be2a173976ca11';
const USER_FACTORY = '0x619814a203ca441611cee02abf31986ca265dd35';

// Pool sizing & filters
const COPY_POOL_SIZE      = 5;            // top 5 by 72h SR
const COPY_POOL_MIN_OPS   = 50;           // ignore small-sample wallets
const COPY_POOL_MIN_SR    = 0.75;         // min 75% SR over 72h

const COPY_POLL_MS         = 30_000;      // poll pool corps every 30s
const COPY_POOL_REFRESH_MS = 15 * 60_000; // re-rank pool every 15min
const COPY_CORPS_REFRESH_MS = 30 * 60_000; // re-fetch each whale's corp list every 30min

const FACTORY_ABI = [
  'function getUserCompanies(address) view returns (address[])',
];
const CORP_ABI = [
  'function isTradeActive() view returns (bool)',
  'function autoTradeMode() view returns (uint8)',
  'function getCooldownEnd() view returns (uint256)',
];
const MC3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[]) external view returns ((bool success, bytes returnData)[])',
];

export interface WhalePoolEntry {
  address: string;
  rank: number;             // 1-based by SR
  successRate: number;      // 0..1
  opsCount: number;
  corps: string[];          // cached company list
  corpsRefreshedAt: number;
}

export interface CopyEvent {
  id: string;               // unique queue id (ts + whale + corp)
  ts: number;               // when WE detected the transition
  whale: string;
  mode: 0 | 1 | 2;          // op mode the whale started
  sourceCorp: string;       // whale corp where it started
  // Persistence id from whale_copy_log (set after CorpBot logs the event).
  // CorpBot reads this back when it fires the copy so it can mark the row
  // as 'fired' rather than creating a new one.
  logId?: number;
}

export interface CopyPoolSnapshot {
  refreshedAt: number;
  pool: WhalePoolEntry[];
  poolMeanSr: number;          // avg SR across pool members
  // The most recent copy events (drained queue). Useful for the
  // dashboard panel showing "what whales just did".
  recentEvents: CopyEvent[];
}

export interface WhaleCopyFeedConfig {
  loadoutScanner: LoadoutScannerFeed;
}

export class WhaleCopyFeed extends EventEmitter {
  private loadoutScanner: LoadoutScannerFeed;
  private provider: ethers.JsonRpcProvider;
  private corpIface: ethers.Interface;
  private mc3: ethers.Contract;

  private pool: WhalePoolEntry[] = [];
  private lastPoolRefreshAt = 0;
  // Per-corp last-known active state, so we detect transitions.
  private corpActive: Map<string, boolean> = new Map();
  // Per-corp last-known autoTradeMode, used as a fallback when the
  // contract doesn't expose the started mode directly. This is the
  // configured mode at the moment the trade kicked off.
  private corpMode: Map<string, number> = new Map();

  // Recent events (last 50) for the dashboard panel
  private recentEvents: CopyEvent[] = [];

  // Per-event listeners use the EventEmitter; we also keep this drainable
  // queue so consumers (CorpBot) that miss live events can pull pending
  // ones at their next tick. Each entry is consumed-once.
  private pendingQueue: CopyEvent[] = [];

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(cfg: WhaleCopyFeedConfig) {
    super();
    this.loadoutScanner = cfg.loadoutScanner;
    this.provider = new ethers.JsonRpcProvider(RPC);
    this.corpIface    = new ethers.Interface(CORP_ABI);
    this.mc3 = new ethers.Contract(MULTICALL3, MC3_ABI, this.provider);
  }

  /** Public read for /bot copy status + dashboard. */
  getSnapshot(): CopyPoolSnapshot {
    const poolMeanSr = this.pool.length === 0 ? 0 :
      this.pool.reduce((s, p) => s + p.successRate, 0) / this.pool.length;
    return {
      refreshedAt: this.lastPoolRefreshAt,
      pool: this.pool.map(p => ({ ...p, corps: [...p.corps] })),
      poolMeanSr,
      recentEvents: [...this.recentEvents],
    };
  }

  /**
   * Drain pending copy events. Callers (CorpBot) should call this every
   * tick and handle each event. Events not consumed within ~5 minutes
   * of detection are stale (whale's op already ran a chunk of its
   * window — copying it now wastes our op spacing).
   */
  drainQueue(): CopyEvent[] {
    const now = Date.now();
    const STALE_MS = 5 * 60_000;
    const fresh = this.pendingQueue.filter(e => now - e.ts < STALE_MS);
    this.pendingQueue = [];
    return fresh;
  }

  /** Lookup current pool's rolling-mean SR. */
  getPoolMeanSr(): number {
    if (this.pool.length === 0) return 0;
    return this.pool.reduce((s, p) => s + p.successRate, 0) / this.pool.length;
  }

  /** True if a wallet is currently in the qualifying pool. */
  isInPool(addr: string): boolean {
    const a = addr.toLowerCase();
    return this.pool.some(p => p.address === a);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    // Don't try to act before the scanner has its first ranking.
    await this.refreshPool().catch(err =>
      logger.warn({ err: err.message }, '[WhaleCopy] initial pool refresh failed'));
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, COPY_POLL_MS);
    logger.info('[WhaleCopy] started');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    logger.info('[WhaleCopy] stopped');
  }

  /**
   * Re-rank the pool from LoadoutScanner's topBySr leaderboard.
   * Filters by min ops + min SR. Caches each whale's corp list (refreshed
   * lazily — cheap factory call but no point hammering it every 30s).
   */
  private async refreshPool(): Promise<void> {
    const snap = this.loadoutScanner.getSnapshot();
    const topBySr = snap.topBySr ?? [];
    if (topBySr.length === 0) return;

    const eligible = topBySr
      .filter(r => r.opsCount >= COPY_POOL_MIN_OPS && r.successRate >= COPY_POOL_MIN_SR)
      .slice(0, COPY_POOL_SIZE);

    // Pull corp lists for any new whales (or refresh stale entries).
    const now = Date.now();
    const next: WhalePoolEntry[] = [];
    for (let i = 0; i < eligible.length; i++) {
      const r = eligible[i];
      const existing = this.pool.find(p => p.address === r.address);
      const stale = !existing || (now - existing.corpsRefreshedAt) > COPY_CORPS_REFRESH_MS;
      let corps: string[];
      let corpsRefreshedAt: number;
      if (stale) {
        try {
          const factory = new ethers.Contract(USER_FACTORY, FACTORY_ABI, this.provider);
          const raw: string[] = await factory.getUserCompanies(r.address);
          // Filter zero addresses (empty corp slots)
          corps = raw.map(c => c.toLowerCase()).filter(c => c !== ethers.ZeroAddress.toLowerCase());
          corpsRefreshedAt = now;
        } catch (err: any) {
          logger.warn({ whale: r.address.slice(0, 10), err: err.message },
            '[WhaleCopy] getUserCompanies failed — using prior list');
          corps = existing?.corps ?? [];
          corpsRefreshedAt = existing?.corpsRefreshedAt ?? 0;
        }
      } else {
        corps = existing!.corps;
        corpsRefreshedAt = existing!.corpsRefreshedAt;
      }
      next.push({
        address: r.address.toLowerCase(),
        rank: i + 1,
        successRate: r.successRate,
        opsCount: r.opsCount,
        corps,
        corpsRefreshedAt,
      });
    }

    // Drop transition-tracking state for whales no longer in the pool —
    // otherwise a removed whale's old corp activity would re-trigger
    // copy events on the next pool re-entry.
    const liveCorps = new Set(next.flatMap(p => p.corps));
    for (const c of [...this.corpActive.keys()]) {
      if (!liveCorps.has(c)) this.corpActive.delete(c);
    }
    for (const c of [...this.corpMode.keys()]) {
      if (!liveCorps.has(c)) this.corpMode.delete(c);
    }

    this.pool = next;
    this.lastPoolRefreshAt = now;
    logger.info({
      poolSize: this.pool.length,
      meanSr: (this.getPoolMeanSr() * 100).toFixed(1),
      whales: this.pool.map(p => `${p.address.slice(0, 10)}@${(p.successRate*100).toFixed(0)}%`).join(','),
    }, '[WhaleCopy] pool refreshed');
  }

  /** Multicall reads for every corp in the pool, then transition-detect. */
  private async tick(): Promise<void> {
    if (!this.running) return;

    // Refresh pool occasionally (cheap — reads in-process state)
    if (Date.now() - this.lastPoolRefreshAt > COPY_POOL_REFRESH_MS) {
      try { await this.refreshPool(); }
      catch (err: any) { logger.warn({ err: err.message }, '[WhaleCopy] pool refresh failed'); }
    }

    const corps = this.pool.flatMap(p => p.corps.map(c => ({ whale: p.address, corp: c })));
    if (corps.length === 0) return;

    // Build multicall: 2 reads per corp (isTradeActive, autoTradeMode)
    // We skip getCooldownEnd — we only care about active-state transitions.
    const calls: any[] = [];
    for (const { corp } of corps) {
      calls.push({
        target: corp, allowFailure: true,
        callData: this.corpIface.encodeFunctionData('isTradeActive', []),
      });
      calls.push({
        target: corp, allowFailure: true,
        callData: this.corpIface.encodeFunctionData('autoTradeMode', []),
      });
    }

    let res: { success: boolean; returnData: string }[];
    try {
      res = await this.mc3.aggregate3.staticCall(calls);
    } catch (err: any) {
      logger.warn({ err: err.message, calls: calls.length }, '[WhaleCopy] multicall failed');
      return;
    }

    const now = Date.now();
    for (let i = 0; i < corps.length; i++) {
      const { whale, corp } = corps[i];
      const aRes = res[i*2 + 0];
      const mRes = res[i*2 + 1];
      if (!aRes?.success || !mRes?.success) continue;
      let nowActive: boolean;
      let nowMode: number;
      try {
        nowActive = this.corpIface.decodeFunctionResult('isTradeActive', aRes.returnData)[0] as boolean;
        nowMode   = Number(this.corpIface.decodeFunctionResult('autoTradeMode', mRes.returnData)[0]);
      } catch { continue; }

      const wasActive = this.corpActive.get(corp);
      this.corpActive.set(corp, nowActive);
      this.corpMode.set(corp, nowMode);

      // Skip on the very first observation — we have nothing to compare to.
      if (wasActive === undefined) continue;

      // Transition: idle → active = whale just bootstrapped an op.
      if (!wasActive && nowActive) {
        // Mode is the autoTradeMode at the moment we observed it. In rare
        // races (whale flipped mode between bootstrap and our poll) this
        // may differ from the actual op mode, but for copy purposes this
        // is good enough — we're trying to match their CURRENT strategy.
        if (nowMode !== 0 && nowMode !== 1 && nowMode !== 2) continue;
        const evt: CopyEvent = {
          id: `${now}-${whale.slice(2, 10)}-${corp.slice(2, 10)}`,
          ts: now,
          whale,
          mode: nowMode as 0 | 1 | 2,
          sourceCorp: corp,
        };
        this.pendingQueue.push(evt);
        this.recentEvents.unshift(evt);
        if (this.recentEvents.length > 50) this.recentEvents.length = 50;
        logger.info(
          { whale: whale.slice(0, 10), corp: corp.slice(0, 10), mode: nowMode },
          '[WhaleCopy] copy event detected',
        );
        this.emit('copy', evt);
      }
    }
  }
}
