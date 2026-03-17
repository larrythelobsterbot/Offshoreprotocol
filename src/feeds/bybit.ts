import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { logger } from '../logger';

const BYBIT_WS = 'wss://stream.bybit.com/v5/public/linear';

export class BybitFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private alive = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  get connected() { return this.alive; }

  start() {
    this.connect();
  }

  stop() {
    this.alive = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private connect() {
    this.ws = new WebSocket(BYBIT_WS);

    this.ws.on('open', () => {
      this.alive = true;
      logger.info('[Bybit] Connected');
      this.emit('status', true);

      // Subscribe
      this.ws!.send(JSON.stringify({
        op: 'subscribe',
        args: [
          'publicTrade.ETHUSDT',
          'orderbook.1.ETHUSDT',
          'liquidation.ETHUSDT',
        ],
      }));

      // Bybit requires ping every 20s
      this.pingTimer = setInterval(() => {
        this.ws?.send(JSON.stringify({ op: 'ping' }));
      }, 20_000);
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
      logger.info('[Bybit] Disconnected, reconnecting in 3s...');
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });

    this.ws.on('error', (err) => {
      logger.error({ err: err.message }, '[Bybit] WS error');
    });
  }

  private route(msg: any) {
    if (msg.op === 'pong' || msg.success !== undefined) return;

    const topic = msg.topic;
    if (!topic) return;

    if (topic === 'publicTrade.ETHUSDT') {
      for (const t of msg.data || []) {
        this.emit('trade', {
          t: parseInt(t.T),
          price: parseFloat(t.p),
          qty: parseFloat(t.v),
          usd: parseFloat(t.p) * parseFloat(t.v),
          buy: t.S === 'Buy',
          src: 'byb' as const,
        });
      }
    }

    else if (topic === 'orderbook.1.ETHUSDT') {
      const d = msg.data;
      if (!d) return;
      const bids = d.b || [];
      const asks = d.a || [];

      let bidTotal = 0, askTotal = 0;
      for (const [p, q] of bids) bidTotal += parseFloat(p) * parseFloat(q);
      for (const [p, q] of asks) askTotal += parseFloat(p) * parseFloat(q);

      const total = bidTotal + askTotal;
      this.emit('orderbook', {
        bids, asks,
        imbalance: total > 0 ? (bidTotal - askTotal) / total : 0,
        bidTotal, askTotal,
        spread: 0,
        spreadPct: 0,
        bidWall: null,
        askWall: null,
      });
    }

    else if (topic === 'liquidation.ETHUSDT') {
      const d = msg.data;
      if (!d) return;
      this.emit('liquidation', {
        t: parseInt(d.updatedTime),
        side: d.side === 'Sell' ? 'long' : 'short',
        price: parseFloat(d.price),
        qty: parseFloat(d.size),
        usd: parseFloat(d.price) * parseFloat(d.size),
        src: 'byb' as const,
      });
    }
  }
}
