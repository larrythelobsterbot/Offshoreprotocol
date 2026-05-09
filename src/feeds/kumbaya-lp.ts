// ============================================================
// KumbayaLPFeed — track liquidity events on the DIRTY/USDM pool.
//
// Three Univ3 events to watch:
//   Mint:    LP added       (someone deposited liquidity)
//   Burn:    LP removed     (someone withdrew their position)
//   Collect: fees collected (usually paired with Burn)
//
// Why this matters: large LP swings change DIRTY price stability.
// When whales pull liquidity, the next sell impacts price more.
// Mint volume is a confidence signal (LPs willing to commit capital
// at the current price). Burn volume is the inverse.
//
// Owner attribution caveat: in Univ3, the LP "owner" is typically
// the Position Manager NFT contract, not the actual user. Resolving
// the true LP requires cross-referencing the matching
// IncreaseLiquidity/DecreaseLiquidity event on the Position Manager
// (1 extra RPC per event). We DON'T do that resolution here; the
// dashboard shows aggregate volumes which are the more useful
// signal anyway.
// ============================================================

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { logger } from '../logger';
import type { Storage, KumbayaLpEventRow } from '../storage/db';

const RPC = 'https://mainnet.megaeth.com/rpc';
const POOL = '0x6bD9eeF21c2419FeffafbF4850153A3b3A74A5E1';

// Univ3 standard event signatures
const MINT_TOPIC    = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde';
const BURN_TOPIC    = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c';
const COLLECT_TOPIC = '0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0';

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_LOOKBACK_BLK = 86400;     // 24h initial backfill
const MAX_BLOCKS_PER_CHUNK = 5000;

export interface KumbayaLpSnapshot {
  lastIngestBlock: number;
  recent: KumbayaLpEventRow[];
  // 24h aggregates for the dashboard summary line
  totals24h: {
    mint_n: number;   mint_dirty: number;   mint_usdm: number;
    burn_n: number;   burn_dirty: number;   burn_usdm: number;
    collect_n: number; collect_dirty: number; collect_usdm: number;
  };
  scannedAt: number;
}

export interface KumbayaLpFeedConfig {
  storage: Storage;
  pollMs?: number;
  rpcUrl?: string;
}

/**
 * Decode signed int24 from a 32-byte topic (sign-extended). Tick values in
 * Univ3 are int24, encoded by left-padding the two's-complement.
 */
function decodeInt24(topicHex: string): number {
  const hex = topicHex.replace(/^0x/, '');
  const v = BigInt('0x' + hex);
  // Sign-extend from 256 bits (the JS BigInt is unsigned)
  // Two's complement: if MSB set, subtract 2^256
  const max = 1n << 256n;
  const half = max / 2n;
  const signed = v >= half ? v - max : v;
  return Number(signed);
}

export class KumbayaLpFeed extends EventEmitter {
  private readonly storage: Storage;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private cursor: number = 0;
  private latest: KumbayaLpSnapshot;
  private blockTsCache: Map<number, number> = new Map();

  constructor(cfg: KumbayaLpFeedConfig) {
    super();
    this.storage = cfg.storage;
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl ?? RPC);
    this.pollMs = cfg.pollMs ?? DEFAULT_POLL_MS;
    this.latest = {
      lastIngestBlock: 0,
      recent: this.storage.getRecentLpEvents(50),
      totals24h: this.computeTotals(this.storage.getRecentLpEvents(500)),
      scannedAt: Date.now(),
    };
  }

  async start(): Promise<void> {
    const dbMax = this.storage.getKumbayaLpMaxBlock();
    const latestBlock = await this.provider.getBlockNumber();
    this.cursor = dbMax > 0 ? dbMax + 1 : Math.max(0, latestBlock - DEFAULT_LOOKBACK_BLK);
    logger.info(
      { cursor: this.cursor, latestBlock, dbMax },
      '[KumbayaLP] starting',
    );
    try { await this.poll(); } catch (err: any) {
      logger.warn({ err: err.message }, '[KumbayaLP] initial poll failed');
    }
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSnapshot(): KumbayaLpSnapshot { return this.latest; }

  private async poll(): Promise<void> {
    const latestBlock = await this.provider.getBlockNumber();
    if (this.cursor > latestBlock) {
      this.latest = { ...this.latest, lastIngestBlock: latestBlock, scannedAt: Date.now() };
      return;
    }

    const newRows: KumbayaLpEventRow[] = [];
    for (let from = this.cursor; from <= latestBlock; from += MAX_BLOCKS_PER_CHUNK) {
      const to = Math.min(from + MAX_BLOCKS_PER_CHUNK - 1, latestBlock);
      // Pull all three event types in parallel (each is sparse — 5/20/20
      // per 24h on Kumbaya). One getLogs call per signature is cheaper
      // than topic-OR which not every RPC supports.
      let mintLogs: ethers.Log[] = [], burnLogs: ethers.Log[] = [], collectLogs: ethers.Log[] = [];
      try {
        [mintLogs, burnLogs, collectLogs] = await Promise.all([
          this.provider.getLogs({ address: POOL, fromBlock: from, toBlock: to, topics: [MINT_TOPIC] }),
          this.provider.getLogs({ address: POOL, fromBlock: from, toBlock: to, topics: [BURN_TOPIC] }),
          this.provider.getLogs({ address: POOL, fromBlock: from, toBlock: to, topics: [COLLECT_TOPIC] }),
        ]);
      } catch (err: any) {
        logger.warn({ err: err.message, from, to }, '[KumbayaLP] getLogs failed');
        continue;
      }

      for (const log of mintLogs) {
        const decoded = this.decodeMint(log);
        if (!decoded) continue;
        const ts = await this.blockTimestamp(log.blockNumber);
        newRows.push({ ...decoded, ts, kind: 'mint' });
      }
      for (const log of burnLogs) {
        const decoded = this.decodeBurn(log);
        if (!decoded) continue;
        const ts = await this.blockTimestamp(log.blockNumber);
        newRows.push({ ...decoded, ts, kind: 'burn' });
      }
      for (const log of collectLogs) {
        const decoded = this.decodeCollect(log);
        if (!decoded) continue;
        const ts = await this.blockTimestamp(log.blockNumber);
        newRows.push({ ...decoded, ts, kind: 'collect' });
      }
    }

    if (newRows.length > 0) {
      this.storage.insertKumbayaLpEvents(newRows);
      logger.info(
        { rows: newRows.length, fromBlock: this.cursor, toBlock: latestBlock,
          mints: newRows.filter(r => r.kind === 'mint').length,
          burns: newRows.filter(r => r.kind === 'burn').length,
          collects: newRows.filter(r => r.kind === 'collect').length },
        '[KumbayaLP] ingested',
      );
    }
    this.cursor = latestBlock + 1;
    this.latest = {
      lastIngestBlock: latestBlock,
      recent: this.storage.getRecentLpEvents(50),
      totals24h: this.computeTotals(this.storage.getRecentLpEvents(500)),
      scannedAt: Date.now(),
    };
    this.emit('snapshot', this.latest);
  }

  /**
   * Mint(address sender, address indexed owner, int24 indexed tickLower,
   *      int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)
   * Topics: [sig, owner, tickLower, tickUpper]
   * Data:   [sender(32), amount(32), amount0(32), amount1(32)]
   */
  private decodeMint(log: ethers.Log): Omit<KumbayaLpEventRow, 'ts' | 'kind'> | null {
    if (log.topics.length < 4) return null;
    const data = log.data.replace(/^0x/, '');
    if (data.length < 4 * 64) return null;
    const owner = '0x' + log.topics[1].slice(-40);
    const tickLower = decodeInt24(log.topics[2]);
    const tickUpper = decodeInt24(log.topics[3]);
    try {
      const liquidity = Number(BigInt('0x' + data.slice(64, 128))) / 1e18;
      const amount0   = Number(BigInt('0x' + data.slice(128, 192))) / 1e18;
      const amount1   = Number(BigInt('0x' + data.slice(192, 256))) / 1e18;
      return {
        block: log.blockNumber, tx_hash: log.transactionHash, log_index: log.index,
        owner, tick_lower: tickLower, tick_upper: tickUpper,
        liquidity, dirty_amount: amount0, usdm_amount: amount1,
      };
    } catch { return null; }
  }

  /**
   * Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper,
   *      uint128 amount, uint256 amount0, uint256 amount1)
   * Topics: [sig, owner, tickLower, tickUpper]
   * Data:   [amount(32), amount0(32), amount1(32)]
   */
  private decodeBurn(log: ethers.Log): Omit<KumbayaLpEventRow, 'ts' | 'kind'> | null {
    if (log.topics.length < 4) return null;
    const data = log.data.replace(/^0x/, '');
    if (data.length < 3 * 64) return null;
    const owner = '0x' + log.topics[1].slice(-40);
    const tickLower = decodeInt24(log.topics[2]);
    const tickUpper = decodeInt24(log.topics[3]);
    try {
      const liquidity = Number(BigInt('0x' + data.slice(0, 64))) / 1e18;
      const amount0   = Number(BigInt('0x' + data.slice(64, 128))) / 1e18;
      const amount1   = Number(BigInt('0x' + data.slice(128, 192))) / 1e18;
      return {
        block: log.blockNumber, tx_hash: log.transactionHash, log_index: log.index,
        owner, tick_lower: tickLower, tick_upper: tickUpper,
        liquidity, dirty_amount: amount0, usdm_amount: amount1,
      };
    } catch { return null; }
  }

  /**
   * Collect(address indexed owner, address recipient, int24 indexed tickLower,
   *         int24 indexed tickUpper, uint128 amount0, uint128 amount1)
   * Topics: [sig, owner, tickLower, tickUpper]
   * Data:   [recipient(32), amount0(32), amount1(32)]
   */
  private decodeCollect(log: ethers.Log): Omit<KumbayaLpEventRow, 'ts' | 'kind'> | null {
    if (log.topics.length < 4) return null;
    const data = log.data.replace(/^0x/, '');
    if (data.length < 3 * 64) return null;
    const owner = '0x' + log.topics[1].slice(-40);
    const tickLower = decodeInt24(log.topics[2]);
    const tickUpper = decodeInt24(log.topics[3]);
    try {
      const amount0 = Number(BigInt('0x' + data.slice(64, 128))) / 1e18;
      const amount1 = Number(BigInt('0x' + data.slice(128, 192))) / 1e18;
      return {
        block: log.blockNumber, tx_hash: log.transactionHash, log_index: log.index,
        owner, tick_lower: tickLower, tick_upper: tickUpper,
        liquidity: null, dirty_amount: amount0, usdm_amount: amount1,
      };
    } catch { return null; }
  }

  private computeTotals(rows: KumbayaLpEventRow[]): KumbayaLpSnapshot['totals24h'] {
    const cutoff = Date.now() - 24 * 3600_000;
    const t = { mint_n: 0, mint_dirty: 0, mint_usdm: 0,
                burn_n: 0, burn_dirty: 0, burn_usdm: 0,
                collect_n: 0, collect_dirty: 0, collect_usdm: 0 };
    for (const r of rows) {
      if (r.ts < cutoff) continue;
      if (r.kind === 'mint')    { t.mint_n++;    t.mint_dirty    += r.dirty_amount; t.mint_usdm    += r.usdm_amount; }
      else if (r.kind === 'burn'){t.burn_n++;    t.burn_dirty    += r.dirty_amount; t.burn_usdm    += r.usdm_amount; }
      else                       { t.collect_n++; t.collect_dirty += r.dirty_amount; t.collect_usdm += r.usdm_amount; }
    }
    return t;
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
