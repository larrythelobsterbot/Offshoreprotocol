import { EventEmitter } from 'events';
import { config } from '../config';
import type {
  CoinglassHeatmapLevel, CoinglassApiResponse,
  CoinglassHeatmapEntry, CoinglassHeatmapSeparated,
} from '../types';
import { logger } from '../logger';

const CG_API = 'https://open-api-v3.coinglass.com/api';

export class CoinglassFeed extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private alive = false;

  get connected() { return this.alive; }

  start() {
    if (!config.coinglassApiKey) {
      logger.info('Coinglass: no API key configured, skipping');
      return;
    }
    this.poll();
    this.timer = setInterval(() => this.poll(), config.cgPollInterval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.alive = false;
  }

  private async poll() {
    try {
      // Fetch liquidation heatmap
      const res = await fetch(
        `${CG_API}/futures/liquidation/map?symbol=ETH&range=1`,
        {
          headers: {
            'accept': 'application/json',
            'CG-API-KEY': config.coinglassApiKey,
          },
        }
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as CoinglassApiResponse;

      if (json.code !== '0' && json.code !== 0) {
        throw new Error(`API error: ${json.msg || json.code}`);
      }

      const data = json.data;
      const levels: CoinglassHeatmapLevel[] = [];

      // Parse heatmap data - structure varies, handle common formats
      if (Array.isArray(data)) {
        for (const entry of data as CoinglassHeatmapEntry[]) {
          if (entry.price && entry.liqValue) {
            levels.push({
              price: parseFloat(entry.price),
              totalValue: parseFloat(entry.liqValue),
              side: (entry.side as 'long' | 'short') || (parseFloat(entry.price) > 0 ? 'long' : 'short'),
            });
          }
        }
      } else if ('longs' in data && 'shorts' in data) {
        const separated = data as CoinglassHeatmapSeparated;
        // Alternative format with separated sides
        for (const entry of separated.longs) {
          const isArray = Array.isArray(entry);
          levels.push({
            price: parseFloat(isArray ? entry[0] : entry.price),
            totalValue: parseFloat(isArray ? entry[1] : entry.liqValue),
            side: 'long',
          });
        }
        for (const entry of separated.shorts) {
          const isArray = Array.isArray(entry);
          levels.push({
            price: parseFloat(isArray ? entry[0] : entry.price),
            totalValue: parseFloat(isArray ? entry[1] : entry.liqValue),
            side: 'short',
          });
        }
      }

      // Sort by total value descending, take top 8
      levels.sort((a, b) => b.totalValue - a.totalValue);
      const topLevels = levels.slice(0, 8);

      this.alive = true;
      this.emit('status', true);
      this.emit('data', topLevels);
    } catch (err: unknown) {
      this.alive = false;
      this.emit('status', false);
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Coinglass poll error');
    }
  }
}
