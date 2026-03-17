import { EventEmitter } from 'events';
import { config } from '../config';
import type { PolymarketData, PolymarketPriceResponse } from '../types';
import { logger } from '../logger';

const POLY_CLOB = 'https://clob.polymarket.com';

export class PolymarketFeed extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private alive = false;

  get connected() { return this.alive; }

  start() {
    if (!config.polymarketTokenId) {
      logger.info('Polymarket: no token ID configured, skipping');
      return;
    }
    this.poll();
    this.timer = setInterval(() => this.poll(), config.polyPollInterval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.alive = false;
  }

  private async poll() {
    try {
      const res = await fetch(
        `${POLY_CLOB}/prices?token_id=${config.polymarketTokenId}`,
        { headers: { 'Accept': 'application/json' } }
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as number | PolymarketPriceResponse;

      // Polymarket prices endpoint returns probability
      const probability = typeof data === 'number' ? data :
                         data?.price ? parseFloat(data.price) :
                         data?.p ? parseFloat(data.p) : null;

      if (probability === null) throw new Error('Could not parse probability');

      const polyData: PolymarketData = {
        probability,
        updatedAt: Date.now(),
      };

      this.alive = true;
      this.emit('status', true);
      this.emit('data', polyData);
    } catch (err: unknown) {
      this.alive = false;
      this.emit('status', false);
      // Don't spam errors if token not configured or API unreachable
      if (this.alive) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message }, 'Polymarket poll error');
      }
    }
  }
}
