// ============================================================
// WhaleTradesFeed — track every DIRTY transfer involving a top-N
// network player.
//
// Approach (Option A from the design doc):
//   • Subscribe via polling to ERC20 Transfer events on the DIRTY token
//     contract. ONE event stream catches every DIRTY movement —
//     Kumbaya DEX swaps, Gacha asset purchases, op payouts from the
//     TradeRouter, Status upgrade burns, whale-to-whale transfers.
//   • Filter to events where `from` or `to` is a tracked whale
//     (top-N by ops count from LoadoutScannerFeed).
//   • Classify by counterparty contract:
//       Kumbaya pool   → DEX trade (buy if whale=to, sell if whale=from)
//       Gacha          → asset_buy
//       TradeRouter    → op_payout (DIRTY mint to player)
//       Zero address   → mint or upgrade (depends on direction)
//       Another whale  → whale-to-whale (sent / received)
//       Other          → other
//   • Persist to `whale_trades` SQLite table, dedup'd by (tx_hash, log_index).
//
// Resume across restarts:
//   • Start from `MAX(block) + 1` in DB; fall back to (latest - lookback)
//     if DB is empty.
//
// Cost: 1 RPC call per poll (DIRTY Transfer events from cursor → latest).
// At ~30s poll cadence and ~600 blocks per poll the load is negligible.
// ============================================================

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { logger } from '../logger';
import type { Storage, WhaleTradeRow, WhaleTradeSide } from '../storage/db';
import type { LoadoutScannerFeed } from './loadout-scanner';

const RPC = 'https://mainnet.megaeth.com/rpc';
const DIRTY_TOKEN  = '0xc2f34f8849a8607fd73e06d6849bda07c2b7de38';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';

// Counterparty registry — maps system contract addresses to labels and
// classification hints. Anything not in this map is treated as a player
// wallet (further refined by checking against the whale set).
//
// Addresses verified by chain probe 2026-05-09. Sources: CLAUDE.md
// "On-chain contracts" registry plus DIRTY Transfer log analysis.
const SYSTEM_CONTRACTS: Record<string, { label: string; hint: 'dex' | 'gacha' | 'router' | 'rewards' | 'vault' | 'game' | 'system' }> = {
  '0x6bd9eef21c2419feffafbf4850153a3b3a74a5e1': { label: 'Kumbaya DEX',    hint: 'dex' },
  '0x1bf6ef01addb0181634370314ac6ee843d4a1c5e': { label: 'Gacha',          hint: 'gacha' },
  '0xf9f676066eb7baeeed93e859bc26a41663f277a8': { label: 'TradeRouter',    hint: 'router' },
  '0x8c73cd3bb0bfb577d4578bb075640c1ecc5027c8': { label: 'CycleRewards',   hint: 'rewards' },
  '0x955a4addc17114c36726c12af9c73e23e497c2bd': { label: 'SwissVault',     hint: 'vault' },
  '0xb0f8243e20a531b0a32bd5270a34ea18c7c4b68e': { label: 'AccountManager', hint: 'game' },
  '0xcd8e5aaee73730347d8a3568d57510158a07b4a6': { label: 'GameProxy',      hint: 'game' },
  '0x619814a203ca441611cee02abf31986ca265dd35': { label: 'UserFactory',    hint: 'game' },
  '0x943b75c86b83b8125d8e2b56d15fd30e8e1a0e74': { label: 'PresaleSBT',     hint: 'system' },
};

const DEFAULT_TOP_N        = 25;
const DEFAULT_POLL_MS      = 30_000;
const DEFAULT_LOOKBACK_BLK = 3600;       // ~1h initial backfill if DB empty
const MAX_BLOCKS_PER_CHUNK = 5000;

export interface WhaleTradesFeedConfig {
  storage: Storage;
  loadoutScanner: LoadoutScannerFeed;
  /** How deep into the network ranking to track. Default 25. */
  topN?: number;
  pollMs?: number;
  /** $DIRTY price provider for USD valuations. Optional. */
  getDirtyPriceUsd?: () => number | null;
  rpcUrl?: string;
}

export interface WhaleTradesSnapshot {
  trackedWallets: number;          // size of the whale set
  topN: number;
  lastIngestBlock: number;
  recent: WhaleTradeRow[];         // last 50 trades
  scannedAt: number;
}

export class WhaleTradesFeed extends EventEmitter {
  private readonly storage: Storage;
  private readonly loadoutScanner: LoadoutScannerFeed;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly topN: number;
  private readonly pollMs: number;
  private readonly getDirtyPriceUsd?: () => number | null;
  private timer: NodeJS.Timeout | null = null;
  private cursor: number = 0;
  /** Lowercased whale addresses with their rank (1..N). */
  private whaleSet: Map<string, number> = new Map();
  private latest: WhaleTradesSnapshot;

  constructor(cfg: WhaleTradesFeedConfig) {
    super();
    this.storage = cfg.storage;
    this.loadoutScanner = cfg.loadoutScanner;
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl ?? RPC);
    this.topN = cfg.topN ?? DEFAULT_TOP_N;
    this.pollMs = cfg.pollMs ?? DEFAULT_POLL_MS;
    this.getDirtyPriceUsd = cfg.getDirtyPriceUsd;
    this.latest = {
      trackedWallets: 0,
      topN: this.topN,
      lastIngestBlock: 0,
      // 200 rather than 50: the client-side SIGNAL filter excludes
      // op_payout/mint (most rows are these), so we need a deeper pool
      // for the signal view to have enough substance. Snapshot is also
      // small JSON, no real cost to bumping.
      recent: this.storage.getRecentWhaleTrades(200),
      scannedAt: Date.now(),
    };
  }

  async start(): Promise<void> {
    this.refreshWhaleSet();
    // Resume cursor from DB (or initial backfill if empty).
    const dbMax = this.storage.getWhaleTradesMaxBlock();
    const latestBlock = await this.provider.getBlockNumber();
    this.cursor = dbMax > 0 ? dbMax + 1 : Math.max(0, latestBlock - DEFAULT_LOOKBACK_BLK);
    logger.info(
      { whales: this.whaleSet.size, topN: this.topN, cursorStart: this.cursor, latestBlock },
      '[WhaleTrades] starting',
    );
    try { await this.poll(); } catch (err: any) {
      logger.warn({ err: err.message }, '[WhaleTrades] initial poll failed');
    }
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    this.timer.unref();
    // Refresh whale set whenever loadout scanner produces a new ranking
    // (every 15 min by its own cadence).
    this.loadoutScanner.on('network', () => this.refreshWhaleSet());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSnapshot(): WhaleTradesSnapshot { return this.latest; }

  /** Refresh the whale set from the latest LoadoutScanner ranking. */
  private refreshWhaleSet(): void {
    const snap = this.loadoutScanner.getSnapshot();
    const top = snap.topPlayers ?? [];
    const next: Map<string, number> = new Map();
    for (let i = 0; i < Math.min(top.length, this.topN); i++) {
      next.set(top[i].address.toLowerCase(), i + 1);
    }
    if (next.size !== this.whaleSet.size) {
      logger.info({ before: this.whaleSet.size, after: next.size }, '[WhaleTrades] whale set updated');
    }
    this.whaleSet = next;
  }

  private async poll(): Promise<void> {
    if (this.whaleSet.size === 0) {
      // Loadout scanner hasn't produced a ranking yet (15-min cadence).
      // Refresh and retry next tick.
      this.refreshWhaleSet();
      if (this.whaleSet.size === 0) return;
    }
    const latestBlock = await this.provider.getBlockNumber();
    if (this.cursor > latestBlock) {
      // Caught up; nothing to do
      this.latest = { ...this.latest, lastIngestBlock: latestBlock, scannedAt: Date.now() };
      return;
    }
    const newRows: WhaleTradeRow[] = [];
    const dirtyUsd = this.getDirtyPriceUsd?.() ?? null;

    for (let from = this.cursor; from <= latestBlock; from += MAX_BLOCKS_PER_CHUNK) {
      const to = Math.min(from + MAX_BLOCKS_PER_CHUNK - 1, latestBlock);
      let logs: ethers.Log[] = [];
      try {
        logs = await this.provider.getLogs({
          address: DIRTY_TOKEN, fromBlock: from, toBlock: to, topics: [TRANSFER_TOPIC],
        });
      } catch (err: any) {
        logger.warn({ err: err.message, from, to }, '[WhaleTrades] getLogs failed');
        continue;
      }
      for (const log of logs) {
        const fromAddr = '0x' + log.topics[1].slice(-40);
        const toAddr   = '0x' + log.topics[2].slice(-40);
        const fromLc = fromAddr.toLowerCase();
        const toLc   = toAddr.toLowerCase();
        const fromIsWhale = this.whaleSet.has(fromLc);
        const toIsWhale   = this.whaleSet.has(toLc);
        if (!fromIsWhale && !toIsWhale) continue;

        // Decode amount (uint256 in data field, no scaling needed beyond 1e18)
        let amount = 0;
        try {
          amount = Number(BigInt(log.data || '0x0')) / 1e18;
        } catch { continue; }
        if (amount <= 0) continue;

        // Determine the whale and counterparty. If BOTH sides are whales,
        // emit two rows so each whale's history shows the trade.
        const ts = await this.blockTimestamp(log.blockNumber);
        const baseRow: Omit<WhaleTradeRow, 'whale_address' | 'whale_rank' | 'side' | 'counterparty' | 'counterparty_label'> = {
          ts,
          block: log.blockNumber,
          tx_hash: log.transactionHash,
          log_index: log.index,
          dirty_amount: amount,
          usd_value: dirtyUsd != null ? amount * dirtyUsd : null,
        };

        const tries: Array<{ whaleLc: string; whaleRank: number; counterpartyLc: string; receiving: boolean }> = [];
        if (fromIsWhale) tries.push({ whaleLc: fromLc, whaleRank: this.whaleSet.get(fromLc)!, counterpartyLc: toLc,   receiving: false });
        if (toIsWhale)   tries.push({ whaleLc: toLc,   whaleRank: this.whaleSet.get(toLc)!,   counterpartyLc: fromLc, receiving: true  });

        for (const t of tries) {
          const sys = SYSTEM_CONTRACTS[t.counterpartyLc];
          const cpIsWhale = this.whaleSet.has(t.counterpartyLc);
          let side: WhaleTradeSide;
          let label: string | null = null;
          if (t.counterpartyLc === ZERO) {
            if (t.receiving) {
              // DIRTY mints from 0x0 to the player on TradeCompleted —
              // the contract bypasses the TradeRouter for direct mints.
              // Empirically, 100 (PL1), 115 (PL2), 130 (PL3) are full
              // rewards; partial liqs land in roughly 30–99 DIRTY.
              // Anything in [30, 300] is almost certainly an op payout.
              // Larger mints are unusual (multi-claim aggregates, vault
              // payouts, etc.) and stay tagged as `mint` so the
              // operator can spot them.
              if (amount >= 30 && amount <= 300) {
                side = 'op_payout';
                label = 'op reward (mint)';
              } else {
                side = 'mint';
                label = 'mint/burn';
              }
            } else {
              // Whale → 0x0 = burn (Status upgrade, asset scrap, etc.)
              side = 'upgrade';
              label = 'mint/burn';
            }
          } else if (sys) {
            label = sys.label;
            if (sys.hint === 'dex')         side = t.receiving ? 'buy' : 'sell';
            else if (sys.hint === 'gacha')  side = 'asset_buy';
            else if (sys.hint === 'router') {
              // VERIFIED 2026-05-09 by tx-receipt inspection on 4 sample
              // events: every `whale → TradeRouter` DIRTY transfer is a
              // SELL routed through the in-game swap helper. The TradeRouter
              // (selector 0xb3f4503a / sellDirty-equivalent) takes DIRTY,
              // swaps on Kumbaya, skims a ~5% fee, returns USDM net.
              //
              // Op payouts come from `0x0` directly (DIRTY mint), NOT via
              // the TradeRouter, so receiving DIRTY FROM the router is
              // most likely a `buy` through the same swap helper. We
              // haven't observed one yet but tag accordingly.
              if (t.receiving) {
                side = 'buy';
                label = 'TradeRouter (buy)';
              } else {
                side = 'sell';
                label = 'TradeRouter (sell)';
              }
            }
            else                            side = 'other';
          } else if (cpIsWhale) {
            side = t.receiving ? 'wt_recv' : 'wt_send';
            label = `whale #${this.whaleSet.get(t.counterpartyLc)}`;
          } else {
            side = 'other';
          }
          newRows.push({
            ...baseRow,
            whale_address: t.whaleLc,
            whale_rank: t.whaleRank,
            side,
            counterparty: t.counterpartyLc,
            counterparty_label: label,
            // log_index needs to be unique per row in the same tx — we
            // bump by 0.5 to give the second row in a whale-to-whale a
            // different unique key while remaining sortable.
            log_index: tries.length === 2 && t.receiving ? log.index * 1000 + 1 : log.index * 1000,
          });
        }
      }
    }

    if (newRows.length > 0) {
      this.storage.insertWhaleTrades(newRows);
      logger.info({ rows: newRows.length, fromBlock: this.cursor, toBlock: latestBlock }, '[WhaleTrades] ingested');
    }
    this.cursor = latestBlock + 1;
    this.latest = {
      trackedWallets: this.whaleSet.size,
      topN: this.topN,
      lastIngestBlock: latestBlock,
      // 200 rather than 50: the client-side SIGNAL filter excludes
      // op_payout/mint (most rows are these), so we need a deeper pool
      // for the signal view to have enough substance. Snapshot is also
      // small JSON, no real cost to bumping.
      recent: this.storage.getRecentWhaleTrades(200),
      scannedAt: Date.now(),
    };
    this.emit('snapshot', this.latest);
  }

  /**
   * Block-timestamp lookup with a small in-memory cache. Multiple events in
   * the same block re-use the lookup so we don't hammer the RPC.
   */
  private blockTsCache: Map<number, number> = new Map();
  private async blockTimestamp(blockNum: number): Promise<number> {
    const cached = this.blockTsCache.get(blockNum);
    if (cached) return cached;
    try {
      const b = await this.provider.getBlock(blockNum);
      const ts = b ? Number(b.timestamp) * 1000 : Date.now();
      this.blockTsCache.set(blockNum, ts);
      // Bound cache size
      if (this.blockTsCache.size > 500) {
        const firstKey = this.blockTsCache.keys().next().value;
        if (firstKey !== undefined) this.blockTsCache.delete(firstKey);
      }
      return ts;
    } catch {
      return Date.now();
    }
  }
}
