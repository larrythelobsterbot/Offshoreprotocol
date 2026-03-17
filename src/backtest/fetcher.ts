// ============================================================
// Phase 4: Historical Kline Fetcher
// Downloads 1-min ETH/USDT candles from Binance Futures (free)
// ============================================================

import { logger } from '../logger';

const BINANCE_API = 'https://fapi.binance.com/fapi/v1/klines';
const SYMBOL = 'ETHUSDT';
const INTERVAL = '1m';
const BATCH_SIZE = 1500; // max per request
const RATE_DELAY = 300; // ms between requests

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

  while (endTime > startTime) {
    const url = `${BINANCE_API}?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${BATCH_SIZE}&endTime=${endTime}`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json() as any[];
      if (!data.length) break;

      for (const k of data) {
        allKlines.push({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        });
      }

      // Move window back
      endTime = data[0][0] - 1;

      if (onProgress) {
        const pct = Math.min(100, ((now - endTime) / (now - startTime)) * 100);
        onProgress(pct, allKlines.length);
      }

      await sleep(RATE_DELAY);
    } catch (err: any) {
      logger.error({ err: err.message, timestamp: new Date(endTime).toISOString() }, '[Fetcher] Error');
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

  logger.info({ count: deduped.length }, `[Fetcher] Downloaded ${deduped.length} unique candles`);
  return deduped;
}
