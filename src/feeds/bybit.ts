import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type {
  BybitTradeMsg, BybitOrderbookMsg, BybitLiquidationMsg, BybitControlMsg,
} from '../types';
import { logger } from '../logger';

const BYBIT_WS = 'wss://stream.bybit.com/v5/public/linear';

// Backoff parameters
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const JITTER_FACTOR = 0.3;

type BybitWsMsg = BybitTradeMsg | BybitOrderbookMsg | BybitLiquidationMsg | BybitControlMsg;

export class BybitFeed extends EventEmitter {
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
    this.ws = new WebSocket(BYBIT_WS);

    this.ws.on('open', () => {
      this.alive = true;
      this.reconnectAttempt = 0;
      logger.info('Bybit connected');
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
        const msg = JSON.parse(raw.toString()) as BybitWsMsg;
        this.route(msg);
      } catch { /* malformed JSON — skip */ }
    });

    this.ws.on('close', () => {
      this.alive = false;
      this.emit('status', false);
      if (this.pingTimer) clearInterval(this.pingTimer);
      const delay = this.getReconnectDelay();
      this.reconnectAttempt++;
      logger.warn({ delay: (delay / 1000).toFixed(1), attempt: this.reconnectAttempt }, 'Bybit disconnected, reconnecting');
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });

    this.ws.on('error', (err) => {
      logger.error({ err: err.message }, 'Bybit WS error');
    });
  }

  private route(msg: BybitWsMsg) {
    if ('op' in msg && (msg.op === 'pong' || msg.success !== undefined)) return;

    if (!('topic' in msg)) return;
    const topic = msg.topic;

    if (topic === 'publicTrade.ETHUSDT') {
      const m = msg as BybitTradeMsg;
      for (const t of m.data) {
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
      const m = msg as BybitOrderbookMsg;
      const d = m.data;
      if (!d) return;
      const bids: [string, string][] = d.b || [];
      const asks: [string, string][] = d.a || [];

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
      const m = msg as BybitLiquidationMsg;
      const d = m.data;
      if (!d) return;
      this.emit('liquidation', {
        t: parseInt(d.updatedTime),
        side: d.side === 'Sell' ? 'long' as const : 'short' as const,
        price: parseFloat(d.price),
        qty: parseFloat(d.size),
        usd: parseFloat(d.price) * parseFloat(d.size),
        src: 'byb' as const,
      });
    }
  }
}
