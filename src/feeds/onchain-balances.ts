// ============================================================
// On-chain wallet balance feed.
//
// Polls the player's INF / DIRTY / USDM ERC-20 balances from
// MegaETH every N seconds and emits a snapshot. Token addresses
// were discovered by probing symbol() on every address in the
// app bundle's compiled JS.
//
// Token contracts (MegaETH mainnet, chain id 4326):
//   INFLUENCE  0x403de0893f0bc66139592ba2fd254672f2db933a   (18 decimals)
//   DIRTY      0xc2f34f8849a8607fd73e06d6849bda07c2b7de38   (18 decimals)
//   USDm       0xfafddbb3fc7688494971a79cc65dca3ef82079e7   (18 decimals)
//
// These are batched into a single Multicall3 aggregate3 call so
// the dashboard reads all three balances in one round-trip.
//
// Running burn / earn rates are tracked as deltas vs. the first
// observed snapshot and time elapsed, so the UI can show
// "INF/hr" without needing historical storage.
// ============================================================

import { EventEmitter } from 'events';
import { logger } from '../logger';

const RPC_URL = 'https://mainnet.megaeth.com/rpc';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

const TOKENS = {
  INF:   { address: '0x403de0893f0bc66139592ba2fd254672f2db933a', decimals: 18 },
  DIRTY: { address: '0xc2f34f8849a8607fd73e06d6849bda07c2b7de38', decimals: 18 },
  USDM:  { address: '0xfafddbb3fc7688494971a79cc65dca3ef82079e7', decimals: 18 },
} as const;

// ABI: balanceOf(address) → uint256, selector 0x70a08231
function encodeBalanceOf(wallet: string): string {
  const padded = wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return '0x70a08231' + padded;
}

// Multicall3.aggregate3((address target, bool allowFailure, bytes callData)[])
// selector 0x82ad56cb
function encodeMulticall3Aggregate3(calls: { target: string; allowFailure: boolean; callData: string }[]): string {
  // Manual ABI encoding — avoids pulling in viem just for one call.
  // Encoded layout:
  //   0x82ad56cb
  //   offset to dynamic array (32) = 0x20
  //   array length
  //   per item: tuple(target, allowFailure, callData)
  // Each tuple is dynamic because of bytes — so the array elements are
  // themselves offsets to inline-encoded tuples.

  // First, compute each tuple's encoded body and figure out where in the
  // tail it goes.
  const tupleBodies: string[] = calls.map(c => {
    const target = c.target.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const allow = (c.allowFailure ? '1' : '0').padStart(64, '0');
    const data = c.callData.replace(/^0x/, '');
    const dataLen = (data.length / 2).toString(16).padStart(64, '0');
    const dataPaddedLen = Math.ceil(data.length / 64) * 64;
    const dataPadded = data.padEnd(dataPaddedLen, '0');
    // Tuple head (3 words) + bytes header (1 word) + bytes data (variable)
    const tupleHead = target + allow + (32 * 3).toString(16).padStart(64, '0'); // callData offset within tuple = 0x60
    return tupleHead + dataLen + dataPadded;
  });

  // Outer array:
  //   offsets table (one per element, relative to start of array body)
  //   element bodies
  let offsetCursor = calls.length * 32;
  const offsetsTable = tupleBodies.map(body => {
    const off = offsetCursor.toString(16).padStart(64, '0');
    offsetCursor += body.length / 2;
    return off;
  });

  const arrayLen = calls.length.toString(16).padStart(64, '0');
  const arrayBody = offsetsTable.join('') + tupleBodies.join('');
  const arrayOuterOffset = '0000000000000000000000000000000000000000000000000000000000000020';

  return '0x82ad56cb' + arrayOuterOffset + arrayLen + arrayBody;
}

// Decode aggregate3 return: tuple(bool success, bytes returnData)[]
function decodeMulticall3Aggregate3(hex: string): { success: boolean; data: string }[] {
  const h = hex.replace(/^0x/, '');
  // skip outer offset (32 bytes)
  const len = parseInt(h.substring(64, 128), 16);
  const arrayBodyStart = 128;
  // offsets table
  const offsets: number[] = [];
  for (let i = 0; i < len; i++) {
    offsets.push(parseInt(h.substring(arrayBodyStart + i * 64, arrayBodyStart + (i + 1) * 64), 16));
  }
  const out: { success: boolean; data: string }[] = [];
  for (let i = 0; i < len; i++) {
    // Each offset is relative to the start of the array body
    const tupleStart = arrayBodyStart + offsets[i] * 2;
    const success = parseInt(h.substring(tupleStart, tupleStart + 64), 16) === 1;
    // bytes offset within tuple (always 0x40 for (bool, bytes))
    const bytesOffset = parseInt(h.substring(tupleStart + 64, tupleStart + 128), 16);
    const bytesAt = tupleStart + bytesOffset * 2;
    const bytesLen = parseInt(h.substring(bytesAt, bytesAt + 64), 16);
    const data = '0x' + h.substring(bytesAt + 64, bytesAt + 64 + bytesLen * 2);
    out.push({ success, data });
  }
  return out;
}

export interface WalletBalances {
  wallet: string;
  inf: number;       // human-readable (decimals applied)
  dirty: number;
  usdm: number;
  // Raw bigints as strings so the WS payload stays JSON-safe.
  infRaw: string;
  dirtyRaw: string;
  usdmRaw: string;
  // First-snapshot reference and rate trackers (USDM/hr equivalent based on per-second deltas)
  firstSnapshotTs: number;
  infPerHour: number | null;       // negative = burning (typical), positive = topped up
  dirtyPerHour: number | null;     // positive = earning
  usdmPerHour: number | null;
  observedSeconds: number;         // time since first snapshot
  lastUpdateTs: number;
  ok: boolean;
  error?: string;
}

export class OnchainBalancesFeed extends EventEmitter {
  private wallet: string | null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private alive = false;
  private pollMs: number;
  private firstSnapshot: { inf: number; dirty: number; usdm: number; ts: number } | null = null;
  private latestBalances: { inf: number; dirty: number; usdm: number } | null = null;

  constructor(wallet: string | null, pollMs = 15_000) {
    super();
    this.wallet = wallet && wallet.length === 42 ? wallet : null;
    this.pollMs = pollMs;
  }

  get connected() { return this.alive; }

  start() {
    if (!this.wallet) {
      logger.info('[OnchainBalances] No WALLET_ADDRESS configured; feed disabled.');
      return;
    }
    void this.poll();
    this.interval = setInterval(() => void this.poll(), this.pollMs);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.alive = false;
  }

  private async poll() {
    if (!this.wallet) return;
    try {
      const data = encodeMulticall3Aggregate3([
        { target: TOKENS.INF.address,   allowFailure: false, callData: encodeBalanceOf(this.wallet) },
        { target: TOKENS.DIRTY.address, allowFailure: false, callData: encodeBalanceOf(this.wallet) },
        { target: TOKENS.USDM.address,  allowFailure: false, callData: encodeBalanceOf(this.wallet) },
      ]);
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: MULTICALL3, data }, 'latest'],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as any;
      if (json.error) throw new Error(json.error.message);
      const decoded = decodeMulticall3Aggregate3(json.result);
      if (decoded.length !== 3 || !decoded.every(r => r.success)) {
        throw new Error('multicall returned partial failure');
      }
      const inf = Number(BigInt(decoded[0].data)) / 1e18;
      const dirty = Number(BigInt(decoded[1].data)) / 1e18;
      const usdm = Number(BigInt(decoded[2].data)) / 1e18;
      const now = Date.now();

      if (!this.firstSnapshot) {
        this.firstSnapshot = { inf, dirty, usdm, ts: now };
      }
      this.latestBalances = { inf, dirty, usdm };

      const elapsedSec = (now - this.firstSnapshot.ts) / 1000;
      const minTrackingSec = 60; // need at least 1 minute before reporting rates
      const hasRate = elapsedSec >= minTrackingSec;

      const snapshot: WalletBalances = {
        wallet: this.wallet,
        inf, dirty, usdm,
        infRaw: BigInt(decoded[0].data).toString(),
        dirtyRaw: BigInt(decoded[1].data).toString(),
        usdmRaw: BigInt(decoded[2].data).toString(),
        firstSnapshotTs: this.firstSnapshot.ts,
        observedSeconds: Math.round(elapsedSec),
        infPerHour:   hasRate ? ((inf - this.firstSnapshot.inf) / elapsedSec) * 3600 : null,
        dirtyPerHour: hasRate ? ((dirty - this.firstSnapshot.dirty) / elapsedSec) * 3600 : null,
        usdmPerHour:  hasRate ? ((usdm - this.firstSnapshot.usdm) / elapsedSec) * 3600 : null,
        lastUpdateTs: now,
        ok: true,
      };

      this.alive = true;
      this.emit('status', true);
      this.emit('balances', snapshot);
    } catch (err: any) {
      this.alive = false;
      this.emit('status', false);
      this.emit('balances', {
        wallet: this.wallet,
        inf: this.latestBalances?.inf ?? 0,
        dirty: this.latestBalances?.dirty ?? 0,
        usdm: this.latestBalances?.usdm ?? 0,
        infRaw: '0', dirtyRaw: '0', usdmRaw: '0',
        firstSnapshotTs: this.firstSnapshot?.ts ?? Date.now(),
        observedSeconds: 0,
        infPerHour: null, dirtyPerHour: null, usdmPerHour: null,
        lastUpdateTs: Date.now(),
        ok: false,
        error: err.message,
      } as WalletBalances);
      logger.error({ err: err.message }, '[OnchainBalances] poll failed');
    }
  }

  /**
   * Reset the rate-tracking baseline so the dashboard's "burn rate"
   * starts fresh from the next snapshot. Useful after a wallet top-up
   * or when starting a new strategy session.
   */
  resetBaseline() {
    this.firstSnapshot = null;
  }
}
