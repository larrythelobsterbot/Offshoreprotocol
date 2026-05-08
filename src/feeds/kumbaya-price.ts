// ============================================================
// Kumbaya DEX price feed.
//
// Pulls the public daily-candle history endpoint that Kumbaya's
// front-end uses to render its swap-page price chart, and also
// tracks live spot price + 24h change for the DIRTY/USDm pair.
//
// Endpoint:
//   https://kumbaaya.exchange/exchange/tokens/<address>/history?chainId=4326
//   → { history: [{ date, priceUSD, totalValueLockedUSD, volumeUSD,
//                   feesUSD, open, high, low, close }, ...] }
//
//   https://kumbaaya.exchange/exchange/tokens/prices?chainId=4326
//   → { prices: { <address>: { priceUSD, priceUSD24hAgo, change24h, ... } } }
//
// History is daily candles; the game launched May 6 2026 so we'll only
// get 1-2 useful candles in the opening days. The intraday picture is
// supplemented by the in-process AMM-rate samples (see PriceHistoryStore
// for the SQLite-backed intraday log).
// ============================================================

import { EventEmitter } from 'events';
import { logger } from '../logger';

const KUMBAYA_HISTORY_URL = 'https://kumbaaya.exchange/exchange/tokens';
const KUMBAYA_PRICES_URL  = 'https://kumbaaya.exchange/exchange/tokens/prices';
const CHAIN_ID = 4326; // MegaETH

export interface PriceCandle {
  ts: number;        // unix seconds (start of day for Kumbaya daily candles)
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUSD: number;
  tvlUSD: number;
}

export interface KumbayaPriceSnapshot {
  symbol: string;
  priceUSD: number;
  priceUSD24hAgo: number | null;
  change24h: number | null;       // %
  // Daily candles, ordered ascending by date. May be empty if the API hasn't
  // populated data yet (very early after launch).
  history: PriceCandle[];
  lastFetchTs: number;            // ms — when we last refreshed
  ok: boolean;
  error?: string;
}

export class KumbayaPriceFeed extends EventEmitter {
  private tokenAddr: string;
  private symbol: string;
  private interval: ReturnType<typeof setInterval> | null = null;
  private pollMs: number;
  private latest: KumbayaPriceSnapshot;

  /**
   * @param tokenAddr  ERC-20 address (lowercase recommended)
   * @param symbol     human label for logs ('DIRTY')
   * @param pollMs     how often to refresh — default 5 min (Kumbaya updates
   *                   their daily candle slowly, no value polling faster)
   */
  constructor(tokenAddr: string, symbol: string = 'DIRTY', pollMs: number = 5 * 60_000) {
    super();
    this.tokenAddr = tokenAddr.toLowerCase();
    this.symbol = symbol;
    this.pollMs = pollMs;
    this.latest = {
      symbol,
      priceUSD: 0,
      priceUSD24hAgo: null,
      change24h: null,
      history: [],
      lastFetchTs: 0,
      ok: false,
    };
  }

  start() {
    void this.tick();
    this.interval = setInterval(() => { void this.tick(); }, this.pollMs);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** Latest snapshot — used by API server when serving DashboardState. */
  getSnapshot(): KumbayaPriceSnapshot { return this.latest; }

  private async tick() {
    try {
      // Run both requests in parallel — Kumbaya serves them from the same backend.
      const [pricesRes, historyRes] = await Promise.all([
        fetch(`${KUMBAYA_PRICES_URL}?chainId=${CHAIN_ID}`),
        fetch(`${KUMBAYA_HISTORY_URL}/${this.tokenAddr}/history?chainId=${CHAIN_ID}`),
      ]);

      if (!pricesRes.ok || !historyRes.ok) {
        throw new Error(`HTTP ${pricesRes.status}/${historyRes.status}`);
      }

      const pricesJson  = await pricesRes.json()  as { prices: Record<string, any> };
      const historyJson = await historyRes.json() as { history: any[] };

      const tokenInfo = pricesJson.prices?.[this.tokenAddr]
                     ?? pricesJson.prices?.[this.tokenAddr.toLowerCase()];
      if (!tokenInfo) {
        throw new Error(`no price entry for ${this.tokenAddr}`);
      }

      const priceUSD       = parseFloat(tokenInfo.priceUSD ?? '0');
      const priceUSD24hAgo = tokenInfo.priceUSD24hAgo != null
                              ? parseFloat(tokenInfo.priceUSD24hAgo)
                              : null;
      const change24h      = tokenInfo.change24h != null
                              ? parseFloat(tokenInfo.change24h)
                              : null;

      // Parse + sort history ascending. Kumbaya returns it descending.
      const history: PriceCandle[] = (historyJson.history ?? [])
        .map((c: any) => ({
          ts:        c.date,
          open:      parseFloat(c.open),
          high:      parseFloat(c.high),
          low:       parseFloat(c.low),
          close:     parseFloat(c.close),
          volumeUSD: parseFloat(c.volumeUSD ?? '0'),
          tvlUSD:    parseFloat(c.totalValueLockedUSD ?? '0'),
        }))
        .filter((c: PriceCandle) =>
          Number.isFinite(c.open)  && Number.isFinite(c.close) &&
          Number.isFinite(c.high)  && Number.isFinite(c.low),
        )
        .sort((a: PriceCandle, b: PriceCandle) => a.ts - b.ts);

      this.latest = {
        symbol:        this.symbol,
        priceUSD,
        priceUSD24hAgo,
        change24h,
        history,
        lastFetchTs:   Date.now(),
        ok:            true,
      };
      this.emit('price', this.latest);
      logger.debug({ priceUSD, change24h, candles: history.length }, '[KumbayaPrice] fetched');
    } catch (err: any) {
      this.latest = { ...this.latest, ok: false, error: err.message, lastFetchTs: Date.now() };
      logger.warn({ err: err.message }, '[KumbayaPrice] fetch failed');
    }
  }
}
