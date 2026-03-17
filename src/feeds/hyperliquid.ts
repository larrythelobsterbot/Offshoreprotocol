import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from '../logger';
import type { HyperliquidContext } from '../types';

const HL_API = 'https://api.hyperliquid.xyz/info';

export class HyperliquidFeed extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private alive = false;

  get connected() { return this.alive; }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), config.hlPollInterval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.alive = false;
  }

  private async poll() {
    try {
      const res = await fetch(HL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as any[];

      // Find ETH in the response
      const meta = data[0];
      const ctxs = data[1];
      const ethIdx = meta.universe.findIndex((u: any) => u.name === 'ETH');

      if (ethIdx === -1) throw new Error('ETH not found in HL universe');

      const ctx = ctxs[ethIdx];
      const markPrice = parseFloat(ctx.markPx);
      const hlData: HyperliquidContext = {
        funding: parseFloat(ctx.funding),
        openInterest: parseFloat(ctx.openInterest) * markPrice,
        markPrice,
        oraclePrice: parseFloat(ctx.oraclePx),
        premium: parseFloat(ctx.premium),
        dayVolume: parseFloat(ctx.dayNtlVlm),
      };

      this.alive = true;
      this.emit('status', true);
      this.emit('data', hlData);
    } catch (err: any) {
      this.alive = false;
      this.emit('status', false);
      logger.error({ err: err.message }, '[Hyperliquid] Poll error');
    }
  }
}
