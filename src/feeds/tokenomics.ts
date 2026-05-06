// ============================================================
// Tokenomics feed — supply tracking and active-player count.
//
// Every TOKENOMICS_POLL_MS the feed:
//
//   1. Reads totalSupply() for $DIRTY, INF, USDM, OSBT via Multicall3
//      (one batched RPC call) and persists each value with a timestamp.
//
//   2. Computes deltas across rolling windows (1h, 24h, 7d) by reading
//      historical snapshots from token_supply_history. Mint rate = supply
//      delta / window. Net inflation %/day = annualized projection.
//
//   3. Scans the most recent ~50k blocks for $DIRTY mint events
//      (Transfer from address(0)) and counts unique recipient addresses.
//      That's the "active player count" — anyone who's claimed an op
//      reward in the recent window.
//
// All four totals are exposed in DashboardState.tokenomics so the
// frontend's TOKENOMICS panel and the hero CTA player-count badge can
// render without further plumbing.
//
// Why this matters: in-game UI doesn't surface supply growth or
// active-player numbers. These metrics are the highest-information
// signals available on chain. They're the foundation for daily
// digests, supply-inflation alerts, and price-prediction content.
// ============================================================

import { EventEmitter } from 'events';
import { logger } from '../logger';
import type { Storage } from '../storage/db';

const RPC_URL = 'https://mainnet.megaeth.com/rpc';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

// Token addresses — confirmed live in earlier recon.
const TOKENS = {
  DIRTY: { address: '0xc2f34f8849a8607fd73e06d6849bda07c2b7de38', decimals: 18 },
  INF:   { address: '0x403de0893f0bc66139592ba2fd254672f2db933a', decimals: 18 },
  USDM:  { address: '0xfafddbb3fc7688494971a79cc65dca3ef82079e7', decimals: 18 },
  OSBT:  { address: '0x943b75c86b83b8125d8e2b56d15fd30e8e1a0e74', decimals: 0 }, // ERC721
} as const;

const TOTAL_SUPPLY_SELECTOR = '0x18160ddd';

// Transfer(address,address,uint256) topic0
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_ADDRESS_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

const DEFAULT_POLL_MS = 5 * 60_000;        // 5 min
const ACTIVE_WINDOW_BLOCKS = 50_000;       // ~14 hours of MegaETH at ~1s blocks (effective)

// --- Multicall3 encoder (mirror of onchain-balances.ts) ---

function pad32(hex: string): string { return hex.padStart(64, '0'); }

function encodeMulticall3Aggregate3(calls: { target: string; allowFailure: boolean; callData: string }[]): string {
  const tupleBodies: string[] = calls.map(c => {
    const target = c.target.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const allow = (c.allowFailure ? '1' : '0').padStart(64, '0');
    const data = c.callData.replace(/^0x/, '');
    const dataLen = (data.length / 2).toString(16).padStart(64, '0');
    const dataPaddedLen = Math.ceil(data.length / 64) * 64;
    const dataPadded = data.padEnd(dataPaddedLen, '0');
    const tupleHead = target + allow + (32 * 3).toString(16).padStart(64, '0');
    return tupleHead + dataLen + dataPadded;
  });
  let offsetCursor = calls.length * 32;
  const offsetsTable = tupleBodies.map(body => {
    const off = offsetCursor.toString(16).padStart(64, '0');
    offsetCursor += body.length / 2;
    return off;
  });
  const arrayLen = calls.length.toString(16).padStart(64, '0');
  const arrayBody = offsetsTable.join('') + tupleBodies.join('');
  return '0x82ad56cb' + '0000000000000000000000000000000000000000000000000000000000000020' + arrayLen + arrayBody;
}

function decodeMulticall3Aggregate3(hex: string): { success: boolean; data: string }[] {
  const h = hex.replace(/^0x/, '');
  const len = parseInt(h.substring(64, 128), 16);
  const arrayBodyStart = 128;
  const offsets: number[] = [];
  for (let i = 0; i < len; i++) {
    offsets.push(parseInt(h.substring(arrayBodyStart + i * 64, arrayBodyStart + (i + 1) * 64), 16));
  }
  const out: { success: boolean; data: string }[] = [];
  for (let i = 0; i < len; i++) {
    const tupleStart = arrayBodyStart + offsets[i] * 2;
    const success = parseInt(h.substring(tupleStart, tupleStart + 64), 16) === 1;
    const bytesOffset = parseInt(h.substring(tupleStart + 64, tupleStart + 128), 16);
    const bytesAt = tupleStart + bytesOffset * 2;
    const bytesLen = parseInt(h.substring(bytesAt, bytesAt + 64), 16);
    const data = '0x' + h.substring(bytesAt + 64, bytesAt + 64 + bytesLen * 2);
    out.push({ success, data });
  }
  return out;
}

async function rpc<T = any>(method: string, params: any[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as any;
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// --- Public types ---

export type TokenSym = 'DIRTY' | 'INF' | 'USDM' | 'OSBT';

export interface TokenSupplySnapshot {
  symbol: TokenSym;
  totalSupply: number;          // human-readable (decimals applied)
  totalSupplyRaw: string;       // raw bigint as string
  // Window deltas — null if no historical snapshot is old enough
  delta1h: number | null;
  delta24h: number | null;
  delta7d: number | null;
  pctChange24h: number | null;
}

export interface TokenomicsBlock {
  lastUpdateTs: number;
  ok: boolean;
  error?: string;
  tokens: {
    DIRTY: TokenSupplySnapshot;
    INF: TokenSupplySnapshot;
    USDM: TokenSupplySnapshot;
    OSBT: TokenSupplySnapshot;
  };
  // Active players: unique recipients of $DIRTY mint events in the recent
  // ACTIVE_WINDOW_BLOCKS. Lower bound on player count (anyone who's
  // claimed an op reward).
  activePlayers: number;
  activePlayersWindowBlocks: number;
}

// --- Feed implementation ---

export class TokenomicsFeed extends EventEmitter {
  private storage: Storage;
  private interval: ReturnType<typeof setInterval> | null = null;
  private alive = false;
  private pollMs: number;
  private latest: TokenomicsBlock | null = null;
  private inFlight = false;

  constructor(storage: Storage, pollMs = DEFAULT_POLL_MS) {
    super();
    this.storage = storage;
    this.pollMs = pollMs;
  }

  get connected() { return this.alive; }
  get latestSnapshot() { return this.latest; }

  start() {
    void this.poll();
    this.interval = setInterval(() => void this.poll(), this.pollMs);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.alive = false;
  }

  private async poll() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const snapshot = await this.fetchSnapshot();
      this.latest = snapshot;
      this.alive = snapshot.ok;
      this.emit('status', snapshot.ok);
      this.emit('tokenomics', snapshot);
    } catch (err: any) {
      this.alive = false;
      this.emit('status', false);
      logger.error({ err: err.message }, '[Tokenomics] poll failed');
    } finally {
      this.inFlight = false;
    }
  }

  private async fetchSnapshot(): Promise<TokenomicsBlock> {
    const now = Date.now();

    // 1. Batch-fetch totalSupply() for all four tokens via Multicall3
    const calls = (Object.keys(TOKENS) as TokenSym[]).map(sym => ({
      target: TOKENS[sym].address,
      allowFailure: false,
      callData: TOTAL_SUPPLY_SELECTOR,
    }));
    const data = encodeMulticall3Aggregate3(calls);
    const resHex = await rpc<string>('eth_call', [{ to: MULTICALL3, data }, 'latest']);
    const decoded = decodeMulticall3Aggregate3(resHex);

    // 2. Persist + compute deltas per token
    const symbols = Object.keys(TOKENS) as TokenSym[];
    const tokens: any = {};
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      const meta = TOKENS[sym];
      const raw = BigInt(decoded[i].data || '0x0');
      const supply = meta.decimals > 0 ? Number(raw) / Math.pow(10, meta.decimals) : Number(raw);

      // Persist this snapshot
      this.storage.insertTokenSupply(sym, now, raw);

      // Read historical snapshots for delta windows
      const oneHourAgo = now - 3600_000;
      const oneDayAgo = now - 86400_000;
      const sevenDaysAgo = now - 7 * 86400_000;
      const snap1h  = this.storage.getSupplyAtOrBefore(sym, oneHourAgo);
      const snap24h = this.storage.getSupplyAtOrBefore(sym, oneDayAgo);
      const snap7d  = this.storage.getSupplyAtOrBefore(sym, sevenDaysAgo);

      const toHuman = (rawStr: string) => meta.decimals > 0 ? Number(BigInt(rawStr)) / Math.pow(10, meta.decimals) : Number(BigInt(rawStr));
      const delta1h  = snap1h  ? supply - toHuman(snap1h.total_supply_raw)  : null;
      const delta24h = snap24h ? supply - toHuman(snap24h.total_supply_raw) : null;
      const delta7d  = snap7d  ? supply - toHuman(snap7d.total_supply_raw)  : null;
      // %change requires a non-zero base
      const pctChange24h = snap24h && toHuman(snap24h.total_supply_raw) > 0
        ? (supply - toHuman(snap24h.total_supply_raw)) / toHuman(snap24h.total_supply_raw) * 100
        : null;

      tokens[sym] = {
        symbol: sym,
        totalSupply: supply,
        totalSupplyRaw: raw.toString(),
        delta1h,
        delta24h,
        delta7d,
        pctChange24h,
      } as TokenSupplySnapshot;
    }

    // 3. Active player count via $DIRTY mint events
    let activePlayers = 0;
    try {
      const latestBlockHex = await rpc<string>('eth_blockNumber', []);
      const latestBlock = Number(BigInt(latestBlockHex));
      const fromBlock = '0x' + Math.max(0, latestBlock - ACTIVE_WINDOW_BLOCKS).toString(16);
      const logs = await rpc<any[]>('eth_getLogs', [{
        address: TOKENS.DIRTY.address,
        topics: [TRANSFER_TOPIC, ZERO_ADDRESS_TOPIC],
        fromBlock,
        toBlock: 'latest',
      }]);
      const recipients = new Set<string>();
      for (const log of logs) {
        if (Array.isArray(log.topics) && log.topics.length >= 3) {
          recipients.add(log.topics[2].slice(-40));
        }
      }
      activePlayers = recipients.size;
    } catch (err: any) {
      // If event scan fails (RPC limit etc.), don't fail the whole poll.
      logger.warn({ err: err.message }, '[Tokenomics] active-player scan failed');
    }

    return {
      lastUpdateTs: now,
      ok: true,
      tokens,
      activePlayers,
      activePlayersWindowBlocks: ACTIVE_WINDOW_BLOCKS,
    };
  }
}
