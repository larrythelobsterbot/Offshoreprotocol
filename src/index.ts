import { BinanceFeed } from './feeds/binance';
import { BybitFeed } from './feeds/bybit';
import { HyperliquidFeed } from './feeds/hyperliquid';
import { HyperliquidWsFeed } from './feeds/hyperliquid-ws';
import { OnchainBalancesFeed } from './feeds/onchain-balances';
import { CorpStateFeed } from './feeds/corp-state';
import { AmmRateFeed } from './feeds/amm-rate';
import { OpScraperFeed } from './feeds/op-scraper';
import { PolymarketFeed } from './feeds/polymarket';
import { CoinglassFeed } from './feeds/coinglass';
import { VolatilityEngine } from './engine/volatility';
import { sendTelegramAlert } from './engine/telegram';
import { Storage } from './storage/db';
import { ApiServer } from './api/server';
import { buildOpStats, getEmpiricalFractions } from './engine/op-stats';
import { config } from './config';
import { logger } from './logger';

async function main() {
  logger.info('='.repeat(50));
  logger.info('  OFFSHORE OPS TERMINAL v3.1');
  logger.info('  ETH Volatility Regime Monitor');
  logger.info('='.repeat(50));

  // Initialize components
  const storage = new Storage();
  const engine = new VolatilityEngine();

  // Op-stats: cache the latest aggregation so getState() doesn't query
  // SQLite on every 1-second broadcast tick. Recompute every 5s, which is
  // fast enough that newly-logged ops show up almost immediately.
  let cachedOpStats = buildOpStats(storage);
  let cachedEmpiricalFractions = getEmpiricalFractions(cachedOpStats);
  setInterval(() => {
    cachedOpStats = buildOpStats(storage);
    cachedEmpiricalFractions = getEmpiricalFractions(cachedOpStats);
  }, 5_000);
  engine.setOpStatsProvider(
    () => cachedOpStats,
    () => cachedEmpiricalFractions,
  );

  const binance = new BinanceFeed();
  const bybit = new BybitFeed();
  const hl = new HyperliquidFeed();        // REST: funding / OI / mark / oracle / volume
  const hlws = new HyperliquidWsFeed();    // WS: trades + L2 book (primary tick source)
  const balances = new OnchainBalancesFeed(config.walletAddress, config.onchainPollInterval);
  const corps = new CorpStateFeed(config.walletAddress, config.onchainPollInterval);
  const amm = new AmmRateFeed(); // 30s default — AMM doesn't move that fast

  // Track the latest corp-address list so the scraper always has fresh inputs.
  let latestCorpAddresses: string[] = [];
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

  // Hyperliquid REST (funding / OI / mark / volume)
  hl.on('data', (data) => engine.onHyperliquid(data));
  hl.on('status', (s) => engine.setConnection('hyperliquid', s));

  // Hyperliquid WS (primary tick + trade + book source).
  // We feed its orderbook into engine.onBinanceOB because that slot is
  // semantically "primary OB" in the dashboard render path. The Binance
  // and Bybit slots stay live in case those feeds ever start delivering
  // data again — the engine will just see the freshest snapshot win.
  hlws.on('tick', (tick) => {
    engine.onTick(tick.p);
    tickBatch.push({ t: tick.t, p: tick.p, src: 'hl' });
  });
  hlws.on('trade', (trade) => {
    engine.onTrade(trade);
    tradeBatch.push(trade);
  });
  hlws.on('orderbook', (ob) => engine.onBinanceOB(ob));
  hlws.on('status', (s) => {
    // hl status is owned by the REST poller; only flip connection state
    // on the AND of the two so the UI doesn't churn on transient WS drops.
    if (!s) engine.setConnection('hyperliquid', false);
  });

  // Polymarket
  poly.on('data', (data) => engine.onPolymarket(data));
  poly.on('status', (s) => engine.setConnection('polymarket', s));

  // Coinglass
  cg.on('data', (data) => engine.onHeatmap(data));
  cg.on('status', (s) => engine.setConnection('coinglass', s));

  // On-chain wallet balances (INF / DIRTY / USDM)
  balances.on('balances', (b) => engine.onWalletBalances(b));

  // Per-corp on-chain state (mode, autoTrade, cooldown, pendingReward, ...)
  corps.on('corps', (b) => {
    engine.onCorpState(b);
    // Feed the live address list to the scraper.
    latestCorpAddresses = b.corps.map((c: any) => c.address.toLowerCase());
  });

  // Live $DIRTY ↔ USDM AMM rate from the in-game Uniswap V3 pool
  amm.on('rate', (r) => engine.onAmmRate(r));

  // On-chain operation outcome scraper. Posts each newly-finalized
  // TradeCompleted event to /api/op-result so the empirical
  // failure-fraction tracker learns from real outcomes automatically.
  const seenTxHashes = new Set<string>();
  const scraper = new OpScraperFeed({
    wallet: config.walletAddress,
    getCorpAddresses: () => latestCorpAddresses,
    baseRewardDirty: parseFloat(process.env.BASE_REWARD_DIRTY || '100'),
    initialLookbackBlocks: parseInt(process.env.OP_SCRAPER_LOOKBACK || '500000'),
    onOutcome: async (o) => {
      // Dedup across restarts within the same session.
      if (seenTxHashes.has(o.txHash)) return;
      seenTxHashes.add(o.txHash);
      if (o.opType === 'unknown') {
        logger.warn({ txHash: o.txHash, durationMin: o.durationMin, mode: o.mode },
          '[OpScraper] outcome with unknown opType; not logging');
        return;
      }
      try {
        const res = await fetch(`http://localhost:${config.port}/api/op-result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            opType: o.opType,
            succeeded: o.succeeded,
            dirtyEarned: o.rewardDirty,
            baseReward: o.baseReward,
            ts: o.ts,
            note: `auto:${o.txHash.slice(0, 12)}...:${o.corp.slice(0, 8)}:m${o.mode}`,
          }),
        });
        if (!res.ok) {
          const txt = await res.text();
          logger.warn({ status: res.status, body: txt.slice(0, 200), txHash: o.txHash },
            '[OpScraper] /api/op-result rejected outcome');
        } else {
          logger.info(
            { op: o.opType, reward: o.rewardDirty, succeeded: o.succeeded, corp: o.corp.slice(0, 10) },
            '[OpScraper] auto-logged outcome',
          );
        }
      } catch (err: any) {
        logger.error({ err: err.message }, '[OpScraper] POST /api/op-result failed');
      }
    },
  });

  // Alerts → Telegram + storage
  engine.on('alert', async (alert) => {
    logger.warn({ alert }, `[ALERT] ${alert.message}`);
    storage.insertAlert(alert);
    await sendTelegramAlert(alert);
    server.broadcastAlert(alert);
  });

  // --- API Server ---
  const onOpStatsChanged = () => {
    cachedOpStats = buildOpStats(storage);
    cachedEmpiricalFractions = getEmpiricalFractions(cachedOpStats);
  };
  const server = new ApiServer(storage, () => engine.getState(), onOpStatsChanged);

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
  hlws.start();
  balances.start();
  void corps.start();
  amm.start();
  // Wait one second after corps.start() before kicking the scraper so the
  // initial company-list fetch has a chance to resolve.
  setTimeout(() => { void scraper.start(); }, 1500);
  poly.start();
  cg.start();

  // Log status every 60s
  setInterval(() => {
    const state = engine.getState();
    const conns = Object.entries(state.connections)
      .map(([k, v]) => `${k}:${v ? '✓' : '✗'}`)
      .join(' ');
    logger.info(
      { ethPrice: state.ethPrice, danger: state.scores.dangerScore, regime: state.volatility.regime, tradeRate: state.meta.tradeRate },
      `[Status] ETH: $${state.ethPrice?.toFixed(2) ?? '---'} | ` +
      `Danger: ${state.scores.dangerScore}/100 | ` +
      `Vol: ${state.volatility.regime} | ` +
      `Trades/min: ${state.meta.tradeRate} | ` +
      `${conns}`
    );
  }, 60_000);

  // Graceful shutdown
  const shutdown = () => {
    logger.info('[Shutdown] Cleaning up...');
    binance.stop();
    bybit.stop();
    hl.stop();
    hlws.stop();
    balances.stop();
    corps.stop();
    amm.stop();
    scraper.stop();
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

  logger.info('[Ready] All feeds started. Waiting for data...');
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
