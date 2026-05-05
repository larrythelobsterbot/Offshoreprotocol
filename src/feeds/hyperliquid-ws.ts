// ============================================================
// Hyperliquid WebSocket feed.
//
// Subscribes to ETH trades and L2 book on api.hyperliquid.xyz.
// Emits the same event shapes as the Binance feed so it can be
// wired into the engine in the same slots:
//   - 'trade'      → engine.onTrade
//   - 'tick'       → engine.onTick (one per trade)
//   - 'orderbook'  → engine.onBinanceOB (slot semantic = "primary OB")
//   - 'status'     → engine.setConnection
//
// Why this exists: Binance/Bybit WebSockets handshake from this VPS
// region but never deliver aggTrade/publicTrade events (geo-policy).
// Hyperliquid is unrestricted and is the canonical perp venue for
// the MegaETH ecosystem the game lives on, so we use it as the
// primary tick + book source.
// ============================================================

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { logger } from '../logger';

const HL_WS = 'wss://api.hyperliquid.xyz/ws';
const COIN = 'ETH';
const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 3_000;

export class HyperliquidWsFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private alive = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  get connected() { return this.alive; }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.alive = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private connect() {
    this.ws = new WebSocket(HL_WS);

    this.ws.on('open', () => {
      this.alive = true;
      logger.info('[HyperliquidWS] Connected');
      this.emit('status', true);

      // Subscribe to trades and L2 book for ETH.
      this.ws!.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'trades', coin: COIN },
      }));
      this.ws!.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'l2Book', coin: COIN },
      }));

      this.pingTimer = setInterval(() => {
        try { this.ws?.send(JSON.stringify({ method: 'ping' })); } catch {}
      }, PING_INTERVAL_MS);
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.route(msg);
      } catch {}
    });

    this.ws.on('close', () => {
      this.alive = false;
      this.emit('status', false);
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.stopped) return;
      logger.info('[HyperliquidWS] Disconnected, reconnecting in 3s...');
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });

    this.ws.on('error', (err) => {
      logger.error({ err: (err as Error).message }, '[HyperliquidWS] WS error');
    });
  }

  private route(msg: any) {
    if (!msg || !msg.channel) return;

    if (msg.channel === 'pong' || msg.channel === 'subscriptionResponse') return;

    if (msg.channel === 'trades') {
      const data: any[] = Array.isArray(msg.data) ? msg.data : [];
      for (const t of data) {
        const price = parseFloat(t.px);
        const qty = parseFloat(t.sz);
        if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;

        // Hyperliquid 'side': "B" = buy aggressor, "A" = sell aggressor.
        // Match the engine's convention (trade.buy = aggressor was buyer).
        const buy = t.side === 'B';

        const trade = {
          t: typeof t.time === 'number' ? t.time : Date.now(),
          price,
          qty,
          usd: price * qty,
          buy,
          src: 'hl' as const,
        };
        this.emit('trade', trade);
        this.emit('tick', { t: trade.t, p: price });
      }
      return;
    }

    if (msg.channel === 'l2Book') {
      const d = msg.data;
      if (!d || !Array.isArray(d.levels) || d.levels.length < 2) return;

      // levels[0] = bids (descending price), levels[1] = asks (ascending price)
      // Each level is { px: string, sz: string, n: number }
      const bidsRaw = d.levels[0] as Array<{ px: string; sz: string; n: number }>;
      const asksRaw = d.levels[1] as Array<{ px: string; sz: string; n: number }>;

      // Take top 5 to match the depth the engine + frontend expect.
      const bids: [string, string][] = bidsRaw.slice(0, 5).map(l => [l.px, l.sz]);
      const asks: [string, string][] = asksRaw.slice(0, 5).map(l => [l.px, l.sz]);

      let bidTotal = 0, askTotal = 0;
      let bidWall: { price: number; size: number } | null = null;
      let askWall: { price: number; size: number } | null = null;

      for (const [p, q] of bids) {
        const px = parseFloat(p), sz = parseFloat(q);
        const size = px * sz;
        bidTotal += size;
        if (!bidWall || size > bidWall.size) bidWall = { price: px, size };
      }
      for (const [p, q] of asks) {
        const px = parseFloat(p), sz = parseFloat(q);
        const size = px * sz;
        askTotal += size;
        if (!askWall || size > askWall.size) askWall = { price: px, size };
      }

      const total = bidTotal + askTotal;
      const imbalance = total > 0 ? (bidTotal - askTotal) / total : 0;
      const bestBid = bids.length ? parseFloat(bids[0][0]) : 0;
      const bestAsk = asks.length ? parseFloat(asks[0][0]) : 0;

      this.emit('orderbook', {
        bids,
        asks,
        imbalance,
        bidTotal,
        askTotal,
        spread: bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : 0,
        spreadPct: bestBid > 0 && bestAsk > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0,
        bidWall,
        askWall,
      });
      return;
    }
  }
}
