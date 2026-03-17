import { EventEmitter } from 'events';
import { config } from '../config';
import type { HyperliquidContext, HyperliquidMetaAndCtxResponse } from '../types';

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
      const data = await res.json() as HyperliquidMetaAndCtxResponse;

      // Find ETH in the response
      const [meta, ctxs] = data;
      const ethIdx = meta.universe.findIndex((u) => u.name === 'ETH');

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
    } catch (err: unknown) {
      this.alive = false;
      this.emit('status', false);
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Hyperliquid] Poll error:', message);
    }
  }
}
