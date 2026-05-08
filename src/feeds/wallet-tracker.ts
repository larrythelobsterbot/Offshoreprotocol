// ============================================================
// WalletTracker — multi-tenant on-demand wallet state service.
//
// Powers the public tracker (FlowDirty.fun) that anyone can use
// to monitor THEIR wallet's positions in real time. Reuses the
// same on-chain readers as the operator's continuous feeds, but:
//
//   - Fetches per-wallet on demand (no background polling)
//   - 30s cache per wallet so repeated hits don't hammer RPC
//   - Inflight de-duplication so concurrent requests share a fetch
//
// Returns a single composed snapshot: balances, status, loadouts
// (with vault projections), corps (with op headroom), cycle
// metadata. All fields are derived from public on-chain state and
// are safe to expose unauthenticated.
// ============================================================

import { ethers } from 'ethers';
import { logger } from '../logger';
import { fetchUserCompanies, fetchCorpStatesFor, computeOpHeadroom } from './corp-state';
import type { CorpState } from './corp-state';
import { computeVaultProjection } from './loadout-scanner';
import type { LoadoutScannerFeed, GeneratorView, InventoryItem, VaultCycle } from './loadout-scanner';

const RPC = 'https://mainnet.megaeth.com/rpc';
const TOKEN_INF   = '0x403de0893f0bc66139592ba2fd254672f2db933a';
const TOKEN_DIRTY = '0xc2f34f8849a8607fd73e06d6849bda07c2b7de38';
const TOKEN_USDM  = '0xfafddbb3fc7688494971a79cc65dca3ef82079e7';
const MULTICALL3  = '0xca11bde05977b3631167028862be2a173976ca11';

const TOKEN_ABI = ['function balanceOf(address) view returns (uint256)'];
const MC3_ABI   = ['function aggregate3((address target, bool allowFailure, bytes callData)[]) external view returns ((bool success, bytes returnData)[])'];

/**
 * Public-safe single-wallet tracker payload. Every field here is derived
 * from public on-chain reads — there is no operator-private data in this
 * shape.
 */
export interface TrackResult {
  wallet: string;
  fetchedAt: number;          // ms
  cachedFor: number;          // ms (TTL hint for the client)
  ethPrice: number | null;    // live ETH/USD from operator's HL feed
  cycle: VaultCycle | null;   // current Swiss Vault cycle anchors

  balances: {
    inf: number;
    dirty: number;
    usdm: number;
  };

  status: {
    level: number;
    xp: number;
    xpToNext: number;          // xp remaining to next status tier
    nextLevelXp: number;       // total XP needed for next tier
  };

  loadouts: GeneratorView[];   // includes vaultProjection
  inventory: InventoryItem[];

  corps: CorpState[];          // includes opHeadroom

  // At-a-glance summary for the marketing UI
  summary: {
    totalCorps: number;
    activeCorps: number;       // corps mid-trade right now
    cooldownCorps: number;
    claimableCorps: number;
    pendingDirty: number;      // sum of pending DIRTY across corps
    minOpHeadroomPct: number | null;   // worst (lowest) headroom across active corps
    worstOpAddr: string | null;        // corp with that worst headroom
    projectedVaultOutputUI: number;    // sum of all loadouts' projected output
    maxSuspicionPct: number | null;    // worst (highest) suspicion across loadouts
    worstLoadoutId: number | null;     // gen with that worst suspicion
  };
}

// Status XP curve from CLAUDE.md / game docs.
const STATUS_XP_REQ = [0, 0, 650, 1950, 3900, 6500, 10400, 15600, 23400, 35100, 52000];

const DEFAULT_CACHE_TTL_MS = 30_000;

interface CacheEntry { data: TrackResult; ts: number; }

export interface WalletTrackerConfig {
  loadoutScanner: LoadoutScannerFeed;
  getEthPrice: () => number | null;
  cacheTtlMs?: number;
}

export class WalletTracker {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<TrackResult>>();
  private provider: ethers.JsonRpcProvider;
  private mc: ethers.Contract;
  private tokenIface: ethers.Interface;
  private mcIface: ethers.Interface;
  private readonly cacheTtlMs: number;
  private readonly loadoutScanner: LoadoutScannerFeed;
  private readonly getEthPrice: () => number | null;

  constructor(cfg: WalletTrackerConfig) {
    this.loadoutScanner = cfg.loadoutScanner;
    this.getEthPrice = cfg.getEthPrice;
    this.cacheTtlMs = cfg.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.provider = new ethers.JsonRpcProvider(RPC);
    this.mc = new ethers.Contract(MULTICALL3, MC3_ABI, this.provider);
    this.tokenIface = new ethers.Interface(TOKEN_ABI);
    this.mcIface = new ethers.Interface(MC3_ABI);
  }

  /** Track a wallet — returns cached result if fresh, else fetches fresh. */
  async track(wallet: string): Promise<TrackResult> {
    const addr = wallet.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) {
      throw new Error('Invalid wallet address');
    }
    const now = Date.now();
    const cached = this.cache.get(addr);
    if (cached && now - cached.ts < this.cacheTtlMs) {
      return { ...cached.data, cachedFor: this.cacheTtlMs - (now - cached.ts) };
    }
    // Coalesce concurrent requests for the same wallet
    const existing = this.inflight.get(addr);
    if (existing) return existing;
    const promise = this.fetchFresh(addr).finally(() => this.inflight.delete(addr));
    this.inflight.set(addr, promise);
    return promise;
  }

  /** Synchronous cache peek for status endpoints. */
  peek(wallet: string): TrackResult | null {
    const cached = this.cache.get(wallet.toLowerCase());
    if (!cached) return null;
    if (Date.now() - cached.ts > this.cacheTtlMs) return null;
    return cached.data;
  }

  /** Number of wallets with cached state right now. */
  size(): number { return this.cache.size; }

  /** Manually evict a wallet (e.g. on user action). */
  evict(wallet: string): void { this.cache.delete(wallet.toLowerCase()); }

  private async fetchFresh(wallet: string): Promise<TrackResult> {
    const t0 = Date.now();
    // Fan out the four primary fetches in parallel
    const [userView, balances, companies, ethPrice] = await Promise.all([
      this.loadoutScanner.fetchUserView(wallet),
      this.fetchBalances(wallet),
      fetchUserCompanies(wallet),
      Promise.resolve(this.getEthPrice()),
    ]);

    // Corp states (depends on companies list) — always run, even if empty
    const corpStatesRaw = companies.length > 0 ? await fetchCorpStatesFor(companies) : [];
    // Enrich corps with live op headroom using operator's ETH price feed
    const corps = corpStatesRaw.map(c => ({
      ...c,
      opHeadroom: computeOpHeadroom(c, ethPrice),
    }));

    // Cycle metadata is shared from the loadoutScanner's cache (no extra RPC).
    const cycle = this.loadoutScanner.getSnapshot().cycle;

    // Status XP next-tier math
    const level = userView?.statusLevel ?? 0;
    const xp = userView?.statusXp ?? 0;
    const nextLevelXp = STATUS_XP_REQ[level + 1] ?? xp;
    const xpToNext = Math.max(0, nextLevelXp - xp);

    // Vault projections are already attached to userView.generators by
    // fetchUserView. If cycle data wasn't yet available at that time,
    // re-attach now so the response is fresh.
    const loadouts: GeneratorView[] = (userView?.generators ?? []).map(g => ({
      ...g,
      vaultProjection: g.vaultProjection ?? computeVaultProjection(g, cycle, Math.floor(Date.now() / 1000)),
    }));

    // Summary stats
    const activeCorps = corps.filter(c => c.tradeInfo?.active).length;
    const cooldownCorps = corps.filter(c => c.cooldownRemainSec > 0 && !c.tradeInfo?.active).length;
    const claimableCorps = corps.filter(c => c.status === 'claimable').length;
    const pendingDirty = corps.reduce((s, c) => s + (c.pendingReward || 0), 0);

    let minOpHeadroomPct: number | null = null;
    let worstOpAddr: string | null = null;
    for (const c of corps) {
      if (!c.opHeadroom) continue;
      if (minOpHeadroomPct === null || c.opHeadroom.headroomPct < minOpHeadroomPct) {
        minOpHeadroomPct = c.opHeadroom.headroomPct;
        worstOpAddr = c.address;
      }
    }

    let maxSuspicionPct: number | null = null;
    let worstLoadoutId: number | null = null;
    let projectedVaultOutputUI = 0;
    for (const g of loadouts) {
      if (!g.vaultProjection) continue;
      projectedVaultOutputUI += g.vaultProjection.projectedOutputUI;
      if (maxSuspicionPct === null || g.vaultProjection.currentSuspicionPct > maxSuspicionPct) {
        maxSuspicionPct = g.vaultProjection.currentSuspicionPct;
        worstLoadoutId = g.id;
      }
    }

    const result: TrackResult = {
      wallet,
      fetchedAt: Date.now(),
      cachedFor: this.cacheTtlMs,
      ethPrice,
      cycle,
      balances,
      status: { level, xp, xpToNext, nextLevelXp },
      loadouts,
      inventory: userView?.inventory ?? [],
      corps,
      summary: {
        totalCorps: corps.length,
        activeCorps,
        cooldownCorps,
        claimableCorps,
        pendingDirty,
        minOpHeadroomPct,
        worstOpAddr,
        projectedVaultOutputUI,
        maxSuspicionPct,
        worstLoadoutId,
      },
    };
    this.cache.set(wallet, { data: result, ts: Date.now() });
    logger.debug({ wallet, ms: Date.now() - t0, corps: corps.length, loadouts: loadouts.length },
      '[WalletTracker] fetched');
    return result;
  }

  private async fetchBalances(wallet: string): Promise<TrackResult['balances']> {
    const calls = [
      { target: TOKEN_INF,   allowFailure: true, callData: this.tokenIface.encodeFunctionData('balanceOf', [wallet]) },
      { target: TOKEN_DIRTY, allowFailure: true, callData: this.tokenIface.encodeFunctionData('balanceOf', [wallet]) },
      { target: TOKEN_USDM,  allowFailure: true, callData: this.tokenIface.encodeFunctionData('balanceOf', [wallet]) },
    ];
    try {
      const r = await this.mc.aggregate3.staticCall(calls);
      const dec = (idx: number): number => {
        if (!r[idx].success) return 0;
        try {
          return Number(this.tokenIface.decodeFunctionResult('balanceOf', r[idx].returnData)[0]) / 1e18;
        } catch { return 0; }
      };
      return { inf: dec(0), dirty: dec(1), usdm: dec(2) };
    } catch {
      return { inf: 0, dirty: 0, usdm: 0 };
    }
  }
}
