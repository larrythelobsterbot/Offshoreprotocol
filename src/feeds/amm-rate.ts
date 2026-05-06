// ============================================================
// $DIRTY ↔ USDM AMM rate feed.
//
// The game's "Buy / Sell $DIRTY" UI is backed by a Uniswap V3 pool
// at fee tier 10000 (1%). We can quote it without authenticating
// by calling the QuoterV2 contract's quoteExactInputSingle in
// "view" mode (eth_call) — the QuoterV2 swallows the would-be
// state changes and returns the amountOut.
//
// Both directions matter:
//   - buyRate  = how many $DIRTY you get per USDM   (UI's "1 USDM = X $DIRTY")
//   - sellRate = how much USDM you get per $DIRTY   (the price you realize when
//                converting earnings back to USDM, used for P&L math)
//
// The sell rate is what the dashboard uses for the wallet panel's
// "NET RATE" calculation, since the player's exit path is
// $DIRTY → USDM → INF.
//
// Key addresses (MegaETH mainnet):
//   QuoterV2:  0x1F1a8dC7E138C34b503Ca080962aC10B75384a27
//   USDM:      0xfafddbb3fc7688494971a79cc65dca3ef82079e7
//   $DIRTY:    0xc2f34f8849a8607fd73e06d6849bda07c2b7de38
//   Fee tier:  10000 (1%)
// ============================================================

import { EventEmitter } from 'events';
import { logger } from '../logger';

const RPC_URL = 'https://mainnet.megaeth.com/rpc';
const QUOTER_V2 = '0x1F1a8dC7E138C34b503Ca080962aC10B75384a27';
const USDM = '0xfafddbb3fc7688494971a79cc65dca3ef82079e7';
const DIRTY = '0xc2f34f8849a8607fd73e06d6849bda07c2b7de38';
const FEE_TIER = 10000; // 1%

// quoteExactInputSingle((address,address,uint256,uint24,uint160))
// Returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 ticksCrossed, uint256 gasEstimate)
const SEL_QUOTE_EXACT_INPUT_SINGLE = '0xc6a5026a';

const DEFAULT_POLL_MS = 30_000;

function pad32(hexNoPrefix: string): string {
  return hexNoPrefix.padStart(64, '0');
}

function encodeQuoteParams(tokenIn: string, tokenOut: string, amountIn: bigint): string {
  const inAddr = pad32(tokenIn.toLowerCase().replace(/^0x/, ''));
  const outAddr = pad32(tokenOut.toLowerCase().replace(/^0x/, ''));
  const amount = pad32(amountIn.toString(16));
  const fee = pad32(FEE_TIER.toString(16));
  const sqrtPriceLimit = pad32('0');
  return SEL_QUOTE_EXACT_INPUT_SINGLE + inAddr + outAddr + amount + fee + sqrtPriceLimit;
}

async function quoteOne(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint> {
  const data = encodeQuoteParams(tokenIn, tokenOut, amountIn);
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: QUOTER_V2, data }, 'latest'],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as any;
  if (json.error) throw new Error(json.error.message);
  const h = (json.result as string).replace(/^0x/, '');
  // amountOut is the first 32-byte word of the returned tuple
  return BigInt('0x' + h.substring(0, 64));
}

export interface AmmRate {
  // buyRate: $DIRTY received per 1 USDM spent
  buyDirtyPerUsdm: number;
  // sellRate: USDM received per 1 $DIRTY sold
  sellUsdmPerDirty: number;
  // Effective $/DIRTY for P&L (sell-side, since that's what you realize)
  dirtyPriceUsdm: number;
  // Spread % (round-trip cost): 1 - sellRate / (1/buyRate)
  spreadPct: number;
  // Pool fee tier
  feeTier: number;
  // Sample size used to detect slippage (here always 1 USDM / 1 DIRTY)
  sampleAmount: number;
  lastUpdateTs: number;
  ok: boolean;
  error?: string;
}

export class AmmRateFeed extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private alive = false;
  private pollMs: number;
  private latest: AmmRate | null = null;

  constructor(pollMs = DEFAULT_POLL_MS) {
    super();
    this.pollMs = pollMs;
  }

  get connected() { return this.alive; }
  get latestRate(): AmmRate | null { return this.latest; }

  start() {
    void this.poll();
    this.interval = setInterval(() => void this.poll(), this.pollMs);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.alive = false;
  }

  private async poll() {
    try {
      // Quote 1 USDM → DIRTY and 1 DIRTY → USDM in parallel
      const ONE = 10n ** 18n;
      const [buyAmount, sellAmount] = await Promise.all([
        quoteOne(USDM, DIRTY, ONE),
        quoteOne(DIRTY, USDM, ONE),
      ]);

      const buyDirtyPerUsdm = Number(buyAmount) / 1e18;
      const sellUsdmPerDirty = Number(sellAmount) / 1e18;
      // Round-trip spread: if you bought $DIRTY then immediately sold it,
      // what fraction of USDM would you have left? 1 - that = spread.
      const roundTripUsdm = sellUsdmPerDirty * buyDirtyPerUsdm;
      const spreadPct = roundTripUsdm > 0 ? (1 - roundTripUsdm) * 100 : 0;

      const snapshot: AmmRate = {
        buyDirtyPerUsdm,
        sellUsdmPerDirty,
        dirtyPriceUsdm: sellUsdmPerDirty,
        spreadPct,
        feeTier: FEE_TIER,
        sampleAmount: 1,
        lastUpdateTs: Date.now(),
        ok: true,
      };
      this.latest = snapshot;
      this.alive = true;
      this.emit('status', true);
      this.emit('rate', snapshot);
    } catch (err: any) {
      const fallback: AmmRate = this.latest ?? {
        buyDirtyPerUsdm: 0,
        sellUsdmPerDirty: 0,
        dirtyPriceUsdm: 0,
        spreadPct: 0,
        feeTier: FEE_TIER,
        sampleAmount: 1,
        lastUpdateTs: Date.now(),
        ok: false,
      };
      const errored: AmmRate = { ...fallback, ok: false, error: err.message, lastUpdateTs: Date.now() };
      this.alive = false;
      this.emit('status', false);
      this.emit('rate', errored);
      logger.error({ err: err.message }, '[AmmRate] poll failed');
    }
  }
}
