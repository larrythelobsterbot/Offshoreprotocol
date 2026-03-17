import { BinanceFeed } from './feeds/binance';
import { BybitFeed } from './feeds/bybit';
import { HyperliquidFeed } from './feeds/hyperliquid';
import { PolymarketFeed } from './feeds/polymarket';
import { CoinglassFeed } from './feeds/coinglass';
import { VolatilityEngine } from './engine/volatility';
import { sendTelegramAlert } from './engine/telegram';
import { Storage } from './storage/db';
import { ApiServer } from './api/server';
import { config } from './config';

async function main() {
  console.log('='.repeat(50));
  console.log('  OFFSHORE OPS TERMINAL v3.0');
  console.log('  ETH Volatility Regime Monitor');
  console.log('='.repeat(50));

  // Initialize components
  const storage = new Storage();
  const engine = new VolatilityEngine();

  const binance = new BinanceFeed();
  const bybit = new BybitFeed();
  const hl = new HyperliquidFeed();
  const poly = new PolymarketFeed();
  const cg = new CoinglassFeed();

  // Trade/tick batching for DB writes
  let tickBatch: { t: number; p: number; src: string }[] = [];
  let tradeBatch: { t: number; price: number; qty: number; usd: number; buy: boolean; src: string }[] = [];

  // --- Wire feeds to engine ---

  // Binance
  binance.on('tick', (tick) => {
    engine.onTick(tick.p);
    tickBatch.push({ t: tick.t, p: tick.p, src: 'bin' });
  });
  binance.on('trade', (trade) => {
    engine.onTrade(trade);
    tradeBatch.push(trade);
  });
  binance.on('orderbook', (ob) => engine.onBinanceOB(ob));
  binance.on('liquidation', (liq) => {
    engine.onLiquidation(liq);
    storage.insertLiquidation(liq);
  });
  binance.on('status', (s) => engine.setConnection('binance', s));

  // Bybit
  bybit.on('trade', (trade) => {
    engine.onTrade(trade);
    tradeBatch.push(trade);
  });
  bybit.on('orderbook', (ob) => engine.onBybitOB(ob));
  bybit.on('liquidation', (liq) => {
    engine.onLiquidation(liq);
    storage.insertLiquidation(liq);
  });
  bybit.on('status', (s) => engine.setConnection('bybit', s));

  // Hyperliquid
  hl.on('data', (data) => engine.onHyperliquid(data));
  hl.on('status', (s) => engine.setConnection('hyperliquid', s));

  // Polymarket
  poly.on('data', (data) => engine.onPolymarket(data));
  poly.on('status', (s) => engine.setConnection('polymarket', s));

  // Coinglass
  cg.on('data', (data) => engine.onHeatmap(data));
  cg.on('status', (s) => engine.setConnection('coinglass', s));

  // Alerts → Telegram + storage
  engine.on('alert', async (alert) => {
    console.log(`[ALERT] ${alert.message}`);
    storage.insertAlert(alert);
    await sendTelegramAlert(alert);
    server.broadcastAlert(alert);
  });

  // --- API Server ---
  const server = new ApiServer(storage, () => engine.getState());

  // --- Periodic tasks ---

  // Flush tick/trade batches to DB every 10s
  setInterval(() => {
    if (tickBatch.length > 0) {
      storage.insertTickBatch(tickBatch);
      tickBatch = [];
    }
    if (tradeBatch.length > 0) {
      storage.insertTradeBatch(tradeBatch);
      tradeBatch = [];
    }
  }, 10_000);

  // Store indicator snapshot every 30s
  setInterval(() => {
    const snapshot = engine.getIndicatorSnapshot();
    if (snapshot.eth_price) {
      storage.insertIndicator(snapshot);
    }
  }, config.indicatorStoreInterval);

  // Broadcast state to WS clients every 1s
  setInterval(() => {
    server.broadcast(engine.getState());
  }, 1000);

  // DB cleanup hourly
  setInterval(() => {
    storage.cleanup();
  }, config.cleanupInterval);

  // --- Start everything ---
  await server.start();
  binance.start();
  bybit.start();
  hl.start();
  poly.start();
  cg.start();

  // Log status every 60s
  setInterval(() => {
    const state = engine.getState();
    const conns = Object.entries(state.connections)
      .map(([k, v]) => `${k}:${v ? '✓' : '✗'}`)
      .join(' ');
    console.log(
      `[Status] ETH: $${state.ethPrice?.toFixed(2) ?? '---'} | ` +
      `Danger: ${state.scores.dangerScore}/100 | ` +
      `Vol: ${state.volatility.regime} | ` +
      `Trades/min: ${state.meta.tradeRate} | ` +
      `${conns}`
    );
  }, 60_000);

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[Shutdown] Cleaning up...');
    binance.stop();
    bybit.stop();
    hl.stop();
    poly.stop();
    cg.stop();
    // Flush remaining batches
    if (tickBatch.length) storage.insertTickBatch(tickBatch);
    if (tradeBatch.length) storage.insertTradeBatch(tradeBatch);
    storage.close();
    server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('\n[Ready] All feeds started. Waiting for data...\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
