// ============================================================
// WhaleClaimsFeed — track CycleRewards claim events.
//
// At the end of each 8h vault cycle, every player calls claim() on
// the CycleRewards contract to receive their pro-rata USDM share.
// Each claim emits topic `0xf01da32686223933...` with:
//   topics[1] = claimer address (indexed)
//   topics[2] = cycleId (indexed)
//   data       = USDM amount (uint256, 1e18 scale)
//
// Why this matters: a claim is the moment a whale realizes their
// cycle profit. Big claimers tend to immediately re-buy INF and
// keep grinding — predictive of upcoming op activity. The list of
// who claimed how much is the cleanest "who's actually winning the
// laundering meta" signal we have access to on-chain.
//
// Empirics from initial probe: ~350 claims per 8h cycle network-
// wide, ranging $5–$300+ per claim. Top 10-20 claimers per cycle
// are basically "who actually plays the game seriously".
// ============================================================

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { logger } from '../logger';
import type { Storage, WhaleClaimRow } from '../storage/db';
import type { LoadoutScannerFeed } from './loadout-scanner';

const RPC = 'https://mainnet.megaeth.com/rpc';
const CYCLE_REWARDS = '0x8C73Cd3BB0bFB577D4578bB075640C1eCc5027c8';
const CLAIM_TOPIC   = '0xf01da32686223933d8a18a391060918c7f11a3648639edd87ae013e2e2731743';

const DEFAULT_POLL_MS = 60_000;          // 1-min cadence; claims cluster at 8h boundaries
const DEFAULT_LOOKBACK_BLK = 86400;      // 24h initial backfill
const MAX_BLOCKS_PER_CHUNK = 5000;

export interface WhaleClaimsSnapshot {
  trackedWhales: number;
  lastIngestBlock: number;
  recent: WhaleClaimRow[];
  scannedAt: number;
  // Per-cycle aggregates: cycle_id → { total USDM, n claims }
  cycleTotals: { cycle_id: number; total_usdm: number; n_claims: number; max_claim: number }[];
}

export interface WhaleClaimsFeedConfig {
  storage: Storage;
  loadoutScanner: LoadoutScannerFeed;
  pollMs?: number;
  rpcUrl?: string;
}

export class WhaleClaimsFeed extends EventEmitter {
  private readonly storage: Storage;
  private readonly loadoutScanner: LoadoutScannerFeed;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private cursor: number = 0;
  private latest: WhaleClaimsSnapshot;
  private blockTsCache: Map<number, number> = new Map();

  constructor(cfg: WhaleClaimsFeedConfig) {
    super();
    this.storage = cfg.storage;
    this.loadoutScanner = cfg.loadoutScanner;
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl ?? RPC);
    this.pollMs = cfg.pollMs ?? DEFAULT_POLL_MS;
    this.latest = {
      trackedWhales: 0,
      lastIngestBlock: 0,
      recent: this.storage.getRecentClaims(100),
      cycleTotals: this.computeCycleTotals(this.storage.getRecentClaims(1000)),
      scannedAt: Date.now(),
    };
  }

  async start(): Promise<void> {
    const dbMax = this.storage.getWhaleClaimsMaxBlock();
    const latestBlock = await this.provider.getBlockNumber();
    this.cursor = dbMax > 0 ? dbMax + 1 : Math.max(0, latestBlock - DEFAULT_LOOKBACK_BLK);
    logger.info(
      { cursor: this.cursor, latestBlock, dbMax },
      '[WhaleClaims] starting',
    );
    try { await this.poll(); } catch (err: any) {
      logger.warn({ err: err.message }, '[WhaleClaims] initial poll failed');
    }
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSnapshot(): WhaleClaimsSnapshot { return this.latest; }

  private async poll(): Promise<void> {
    const latestBlock = await this.provider.getBlockNumber();
    if (this.cursor > latestBlock) {
      this.latest = { ...this.latest, lastIngestBlock: latestBlock, scannedAt: Date.now() };
      return;
    }

    // Get current top-N whale ranking for rank annotation
    const snap = this.loadoutScanner.getSnapshot();
    const rankMap = new Map<string, number>();
    (snap.topPlayers ?? []).forEach((p, i) => rankMap.set(p.address.toLowerCase(), i + 1));

    const newRows: WhaleClaimRow[] = [];
    for (let from = this.cursor; from <= latestBlock; from += MAX_BLOCKS_PER_CHUNK) {
      const to = Math.min(from + MAX_BLOCKS_PER_CHUNK - 1, latestBlock);
      let logs: ethers.Log[] = [];
      try {
        logs = await this.provider.getLogs({
          address: CYCLE_REWARDS, fromBlock: from, toBlock: to, topics: [CLAIM_TOPIC],
        });
      } catch (err: any) {
        logger.warn({ err: err.message, from, to }, '[WhaleClaims] getLogs failed');
        continue;
      }
      for (const log of logs) {
        if (log.topics.length < 3) continue;
        const claimer = '0x' + log.topics[1].slice(-40);
        const cycleId = parseInt(log.topics[2], 16);
        let usdmAmount = 0;
        try { usdmAmount = Number(BigInt(log.data || '0x0')) / 1e18; } catch { continue; }
        if (usdmAmount <= 0) continue;
        const ts = await this.blockTimestamp(log.blockNumber);
        newRows.push({
          ts,
          block: log.blockNumber,
          tx_hash: log.transactionHash,
          log_index: log.index,
          claimer: claimer.toLowerCase(),
          cycle_id: cycleId,
          usdm_amount: usdmAmount,
          whale_rank: rankMap.get(claimer.toLowerCase()) ?? null,
        });
      }
    }

    if (newRows.length > 0) {
      this.storage.insertWhaleClaims(newRows);
      logger.info(
        { rows: newRows.length, fromBlock: this.cursor, toBlock: latestBlock },
        '[WhaleClaims] ingested',
      );
    }
    this.cursor = latestBlock + 1;

    const recent = this.storage.getRecentClaims(100);
    this.latest = {
      trackedWhales: rankMap.size,
      lastIngestBlock: latestBlock,
      recent,
      cycleTotals: this.computeCycleTotals(this.storage.getRecentClaims(2000)),
      scannedAt: Date.now(),
    };
    this.emit('snapshot', this.latest);
  }

  private computeCycleTotals(rows: WhaleClaimRow[]): WhaleClaimsSnapshot['cycleTotals'] {
    const map = new Map<number, { total: number; n: number; max: number }>();
    for (const r of rows) {
      const cur = map.get(r.cycle_id) ?? { total: 0, n: 0, max: 0 };
      cur.total += r.usdm_amount;
      cur.n++;
      cur.max = Math.max(cur.max, r.usdm_amount);
      map.set(r.cycle_id, cur);
    }
    return [...map.entries()]
      .map(([cycle_id, v]) => ({ cycle_id, total_usdm: v.total, n_claims: v.n, max_claim: v.max }))
      .sort((a, b) => b.cycle_id - a.cycle_id);
  }

  private async blockTimestamp(blockNum: number): Promise<number> {
    const cached = this.blockTsCache.get(blockNum);
    if (cached) return cached;
    try {
      const b = await this.provider.getBlock(blockNum);
      const ts = b ? Number(b.timestamp) * 1000 : Date.now();
      this.blockTsCache.set(blockNum, ts);
      if (this.blockTsCache.size > 500) {
        const first = this.blockTsCache.keys().next().value;
        if (first !== undefined) this.blockTsCache.delete(first);
      }
      return ts;
    } catch { return Date.now(); }
  }
}
