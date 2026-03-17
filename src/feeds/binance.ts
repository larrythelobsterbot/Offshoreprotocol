import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type {
  BinanceAggTradeMsg, BinanceDepthMsg, BinanceForceOrderMsg, BinanceKlineMsg,
} from '../types';
import { logger } from '../logger';

const BINANCE_WS = 'wss://fstream.binance.com/ws';
const STREAMS = [
  'ethusdt@aggTrade',
  'ethusdt@depth5@100ms',
  'ethusdt@forceOrder',
  'ethusdt@kline_1m',
];

// Backoff parameters
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const JITTER_FACTOR = 0.3;

export class BinanceFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private alive = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;

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

  private getReconnectDelay(): number {
    const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** this.reconnectAttempt);
    const jitter = exponential * JITTER_FACTOR * (2 * Math.random() - 1);
    return Math.max(0, exponential + jitter);
  }

  private connect() {
    const url = `${BINANCE_WS}/${STREAMS.join('/')}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.alive = true;
      this.reconnectAttempt = 0;
      logger.info('Binance connected');
      this.emit('status', true);
      this.pingTimer = setInterval(() => this.ws?.ping(), 30_000);
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as
          BinanceAggTradeMsg | BinanceDepthMsg | BinanceForceOrderMsg | BinanceKlineMsg;
        this.route(msg);
      } catch { /* malformed JSON — skip */ }
    });

    this.ws.on('close', () => {
      this.alive = false;
      this.emit('status', false);
      if (this.pingTimer) clearInterval(this.pingTimer);
      const delay = this.getReconnectDelay();
      this.reconnectAttempt++;
      logger.warn({ delay: (delay / 1000).toFixed(1), attempt: this.reconnectAttempt }, 'Binance disconnected, reconnecting');
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });

    this.ws.on('error', (err) => {
      logger.error({ err: err.message }, 'Binance WS error');
    });
  }

  private route(msg: BinanceAggTradeMsg | BinanceDepthMsg | BinanceForceOrderMsg | BinanceKlineMsg) {
    const e = msg.e;
    if (!e) return;

    if (e === 'aggTrade') {
      const m = msg as BinanceAggTradeMsg;
      const trade = {
        t: m.T,
        price: parseFloat(m.p),
        qty: parseFloat(m.q),
        usd: parseFloat(m.p) * parseFloat(m.q),
        buy: !m.m,  // m = true means maker is buyer, so taker is seller
        src: 'bin' as const,
      };
      this.emit('trade', trade);
      this.emit('tick', { t: m.T, p: trade.price });
    }

    else if (e === 'depthUpdate' || 'lastUpdateId' in msg) {
      // depth5 stream
      const m = msg as BinanceDepthMsg;
      const bids: [string, string][] = m.b || m.bids || [];
      const asks: [string, string][] = m.a || m.asks || [];

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
      const o = (msg as BinanceForceOrderMsg).o;
      this.emit('liquidation', {
        t: o.T,
        side: o.S === 'SELL' ? 'long' as const : 'short' as const,
        price: parseFloat(o.p),
        qty: parseFloat(o.q),
        usd: parseFloat(o.p) * parseFloat(o.q),
        src: 'bin' as const,
      });
    }

    else if (e === 'kline') {
      const k = (msg as BinanceKlineMsg).k;
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
