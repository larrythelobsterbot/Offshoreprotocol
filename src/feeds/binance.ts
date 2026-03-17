import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { logger } from '../logger';

const BINANCE_WS = 'wss://fstream.binance.com/ws';
const STREAMS = [
  'ethusdt@aggTrade',
  'ethusdt@depth5@100ms',
  'ethusdt@forceOrder',
  'ethusdt@kline_1m',
];

export class BinanceFeed extends EventEmitter {
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
    const url = `${BINANCE_WS}/${STREAMS.join('/')}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.alive = true;
      logger.info('[Binance] Connected');
      this.emit('status', true);
      this.pingTimer = setInterval(() => this.ws?.ping(), 30_000);
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
      logger.info('[Binance] Disconnected, reconnecting in 3s...');
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });

    this.ws.on('error', (err) => {
      logger.error({ err: err.message }, '[Binance] WS error');
    });
  }

  private route(msg: any) {
    const e = msg.e;
    if (!e) return;

    if (e === 'aggTrade') {
      const trade = {
        t: msg.T,
        price: parseFloat(msg.p),
        qty: parseFloat(msg.q),
        usd: parseFloat(msg.p) * parseFloat(msg.q),
        buy: !msg.m,  // m = true means maker is buyer, so taker is seller
        src: 'bin' as const,
      };
      this.emit('trade', trade);
      this.emit('tick', { t: msg.T, p: trade.price });
    }

    else if (e === 'depthUpdate' || msg.lastUpdateId) {
      // depth5 stream
      const bids = msg.b || msg.bids || [];
      const asks = msg.a || msg.asks || [];

      let bidTotal = 0, askTotal = 0;
      let bidWall: { price: number; size: number } | null = null;
      let askWall: { price: number; size: number } | null = null;

      for (const [p, q] of bids) {
        const size = parseFloat(p) * parseFloat(q);
        bidTotal += size;
        if (!bidWall || size > bidWall.size) bidWall = { price: parseFloat(p), size };
      }
      for (const [p, q] of asks) {
        const size = parseFloat(p) * parseFloat(q);
        askTotal += size;
        if (!askWall || size > askWall.size) askWall = { price: parseFloat(p), size };
      }

      const total = bidTotal + askTotal;
      const imbalance = total > 0 ? (bidTotal - askTotal) / total : 0;
      const bestBid = bids.length ? parseFloat(bids[0][0]) : 0;
      const bestAsk = asks.length ? parseFloat(asks[0][0]) : 0;

      this.emit('orderbook', {
        bids, asks, imbalance,
        bidTotal, askTotal,
        spread: bestAsk - bestBid,
        spreadPct: bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0,
        bidWall, askWall,
      });
    }

    else if (e === 'forceOrder') {
      const o = msg.o;
      this.emit('liquidation', {
        t: o.T,
        side: o.S === 'SELL' ? 'long' : 'short',
        price: parseFloat(o.p),
        qty: parseFloat(o.q),
        usd: parseFloat(o.p) * parseFloat(o.q),
        src: 'bin' as const,
      });
    }

    else if (e === 'kline') {
      const k = msg.k;
      if (k.x) {  // kline closed
        this.emit('kline', {
          t: k.t,
          o: parseFloat(k.o),
          h: parseFloat(k.h),
          l: parseFloat(k.l),
          c: parseFloat(k.c),
          v: parseFloat(k.v),
        });
      }
    }
  }
}
