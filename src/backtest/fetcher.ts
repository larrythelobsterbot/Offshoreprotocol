// ============================================================
// Phase 4: Historical Kline Fetcher
//
// Downloads 1-min ETH candles from one of three sources:
//   1) Hyperliquid /info candleSnapshot (preferred — same exchange
//      the live engine already polls for funding/OI, perp ETH,
//      permissionless, keyless, 5000 candles per request, no geo-block).
//   2) Binance Futures fapi (used by the production VPS in regions
//      where it's reachable).
//   3) Coinbase Exchange ETH-USD spot (universal fallback).
//
// Each batch is normalized to the same Kline shape. The fetcher
// tries sources in order; on geo-block / repeated errors it falls
// through to the next source rather than aborting.
// ============================================================

import { logger } from '../logger';

const HL_API = 'https://api.hyperliquid.xyz/info';
const BINANCE_API = 'https://fapi.binance.com/fapi/v1/klines';
const COINBASE_API = 'https://api.exchange.coinbase.com/products/ETH-USD/candles';

const RATE_DELAY = 250; // ms between requests
const MAX_CONSECUTIVE_ERRORS = 4;

type Source = 'hyperliquid' | 'binance' | 'coinbase';
// Order matters:
//   - binance: best history depth and same exchange the live WebSocket
//     trades feed uses, but geo-blocked from some regions.
//   - coinbase: globally accessible spot fallback, full multi-year history.
//   - hyperliquid: same exchange the live engine polls for funding/OI,
//     but the candleSnapshot endpoint only retains ~3.5 days of 1-min
//     candles, so it's a last resort for long backtests.
const SOURCE_ORDER: Source[] = ['binance', 'coinbase', 'hyperliquid'];

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Hyperliquid candleSnapshot: returns ASCENDING list of objects
//   {t: openMs, T: closeMs, s, i, o, c, h, l, v, n}  (numeric fields are strings)
// Tested empirically: up to ~5000 candles per request.
async function fetchHyperliquidBatch(endTime: number, candleCount = 5000): Promise<Kline[] | 'blocked' | null> {
  const startTime = endTime - candleCount * 60_000;
  const body = {
    type: 'candleSnapshot',
    req: { coin: 'ETH', interval: '1m', startTime, endTime },
  };
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 451 || res.status === 403) return 'blocked';
  if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
  const data = (await res.json()) as any[];
  if (!Array.isArray(data) || data.length === 0) return null;
  return data.map(k => ({
    openTime: k.t,
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low: parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v),
  }));
}

// Binance Futures: returns ASCENDING list of arrays
//   [openTime, open, high, low, close, volume, ...]
async function fetchBinanceBatch(endTime: number, limit = 1500): Promise<Kline[] | 'blocked' | null> {
  const url = `${BINANCE_API}?symbol=ETHUSDT&interval=1m&limit=${limit}&endTime=${endTime}`;
  const res = await fetch(url);
  if (res.status === 451 || res.status === 403 || res.status === 418) return 'blocked';
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const data = (await res.json()) as any[];
  if (!Array.isArray(data) || data.length === 0) return null;
  return data.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// Coinbase Exchange ETH-USD spot: DESCENDING list, max 300 per request
//   [time_seconds, low, high, open, close, volume]
async function fetchCoinbaseBatch(endTime: number, limit = 300): Promise<Kline[] | 'blocked' | null> {
  const startMs = endTime - limit * 60_000;
  const startISO = new Date(startMs).toISOString();
  const endISO = new Date(endTime).toISOString();
  const url = `${COINBASE_API}?granularity=60&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'offshore-ops-backtester/1.0' } });
  if (res.status === 451 || res.status === 403) return 'blocked';
  if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
  const data = (await res.json()) as any[];
  if (!Array.isArray(data) || data.length === 0) return null;
  const asc = [...data].reverse();
  return asc.map(k => ({
    openTime: k[0] * 1000,
    open: k[3],
    high: k[2],
    low: k[1],
    close: k[4],
    volume: k[5],
  }));
}

async function fetchOne(source: Source, endTime: number) {
  switch (source) {
    case 'hyperliquid': return fetchHyperliquidBatch(endTime, 5000);
    case 'binance':     return fetchBinanceBatch(endTime, 1500);
    case 'coinbase':    return fetchCoinbaseBatch(endTime, 300);
  }
}

export async function fetchKlines(
  daysBack: number,
  onProgress?: (pct: number, count: number) => void
): Promise<Kline[]> {
  const now = Date.now();
  const startTime = now - daysBack * 86400_000;
  const allKlines: Kline[] = [];
  let endTime = now;

  const totalMinutes = daysBack * 24 * 60;
  logger.info({ totalMinutes, daysBack }, `[Fetcher] Downloading ~${totalMinutes} candles`);

  let sourceIdx = 0;
  let source: Source = SOURCE_ORDER[sourceIdx];
  let consecutiveErrors = 0;
  logger.info({ source }, `[Fetcher] Starting with source=${source}`);

  while (endTime > startTime) {
    try {
      const batch = await fetchOne(source, endTime);

      if (batch === 'blocked') {
        sourceIdx++;
        if (sourceIdx >= SOURCE_ORDER.length) {
          logger.error('[Fetcher] All sources geo-blocked. Aborting.');
          break;
        }
        source = SOURCE_ORDER[sourceIdx];
        consecutiveErrors = 0;
        logger.warn({ next: source }, `[Fetcher] Source blocked; falling through.`);
        continue;
      }

      if (batch === null) {
        // Source ran out before we hit startTime. Could be retention
        // limits (Hyperliquid only keeps ~3.5 days of 1m candles) or a
        // genuine end-of-data. If we have more sources, try the next.
        sourceIdx++;
        if (sourceIdx >= SOURCE_ORDER.length) {
          logger.info('[Fetcher] All sources exhausted at this depth; stopping.');
          break;
        }
        const next = SOURCE_ORDER[sourceIdx];
        logger.warn(
          { from: source, to: next, oldestSoFar: new Date(endTime).toISOString() },
          `[Fetcher] Source returned no more data; switching to ${next}.`,
        );
        source = next;
        consecutiveErrors = 0;
        continue;
      }

      allKlines.push(...batch);
      consecutiveErrors = 0;
      endTime = batch[0].openTime - 1;

      if (onProgress) {
        const pct = Math.min(100, ((now - endTime) / (now - startTime)) * 100);
        onProgress(pct, allKlines.length);
      }
      await sleep(RATE_DELAY);
    } catch (err: any) {
      consecutiveErrors++;
      logger.error(
        { err: err.message, source, consecutiveErrors, ts: new Date(endTime).toISOString() },
        '[Fetcher] Error',
      );
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        sourceIdx++;
        if (sourceIdx >= SOURCE_ORDER.length) {
          logger.error('[Fetcher] All sources exhausted. Aborting.');
          break;
        }
        source = SOURCE_ORDER[sourceIdx];
        consecutiveErrors = 0;
        logger.warn({ next: source }, `[Fetcher] Switching source after repeated errors.`);
        continue;
      }
      await sleep(2000);
    }
  }

  // Sort chronologically and deduplicate
  allKlines.sort((a, b) => a.openTime - b.openTime);
  const seen = new Set<number>();
  const deduped = allKlines.filter(k => {
    if (seen.has(k.openTime)) return false;
    seen.add(k.openTime);
    return true;
  });

  logger.info({ count: deduped.length, lastSource: source }, `[Fetcher] Downloaded ${deduped.length} unique candles`);
  return deduped;
}
