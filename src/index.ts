import { BinanceFeed } from './feeds/binance';
import { BybitFeed } from './feeds/bybit';
import { HyperliquidFeed } from './feeds/hyperliquid';
import { HyperliquidWsFeed } from './feeds/hyperliquid-ws';
import { OnchainBalancesFeed } from './feeds/onchain-balances';
import { CorpStateFeed } from './feeds/corp-state';
import { AmmRateFeed } from './feeds/amm-rate';
import { OpScraperFeed } from './feeds/op-scraper';
import { TokenomicsFeed } from './feeds/tokenomics';
import { KumbayaPriceFeed } from './feeds/kumbaya-price';
import { LoadoutScannerFeed } from './feeds/loadout-scanner';
import { PolymarketFeed } from './feeds/polymarket';
import { CoinglassFeed } from './feeds/coinglass';
import { VolatilityEngine } from './engine/volatility';
import { sendTelegramAlert } from './engine/telegram';
import { Storage } from './storage/db';
import { ApiServer } from './api/server';
import { buildOpStats, getEmpiricalFractions } from './engine/op-stats';
import { buildSummaryBundle } from './engine/op-summary';
import { TgBot } from './engine/tgbot';
import { SubscriberPoller } from './engine/sub-poller';
import { Broadcaster } from './engine/broadcaster';
import { CorpBot } from './engine/corp-bot';
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

  // Op-stats + activity rollups: cache so getState() doesn't query SQLite on
  // every 1-second broadcast tick. Recompute every 5s — fast enough that newly
  // logged ops show up almost immediately.
  const sessionStartMs = Date.now();
  let cachedOpStats = buildOpStats(storage);
  let cachedEmpiricalFractions = getEmpiricalFractions(cachedOpStats);
  let cachedActivity = buildSummaryBundle(storage, sessionStartMs);
  setInterval(() => {
    cachedOpStats = buildOpStats(storage);
    cachedEmpiricalFractions = getEmpiricalFractions(cachedOpStats);
    cachedActivity = buildSummaryBundle(storage, sessionStartMs);
  }, 5_000);
  engine.setOpStatsProvider(
    () => cachedOpStats,
    () => cachedEmpiricalFractions,
    () => cachedActivity,
  );

  const binance = new BinanceFeed();
  const bybit = new BybitFeed();
  const hl = new HyperliquidFeed();        // REST: funding / OI / mark / oracle / volume
  const hlws = new HyperliquidWsFeed();    // WS: trades + L2 book (primary tick source)
  const balances = new OnchainBalancesFeed(config.walletAddress, config.onchainPollInterval);
  const corps = new CorpStateFeed(config.walletAddress, config.onchainPollInterval);
  const amm = new AmmRateFeed(); // 30s default — AMM doesn't move that fast
  const tokenomics = new TokenomicsFeed(storage); // 5-min default poll
  // Kumbaya DEX price feed for $DIRTY — daily candles + 24h change. 5-min poll.
  const dirtyPrice = new KumbayaPriceFeed(
    '0xc2f34f8849a8607fd73e06d6849bda07c2b7de38',
    'DIRTY',
    5 * 60_000,
  );
  // Loadout scanner — operator's loadouts (60s) + network meta (15min)
  const loadoutScanner = new LoadoutScannerFeed({
    walletAddress:        config.walletAddress,
    selfPollMs:           60_000,
    networkPollMs:        15 * 60_000,
    topPlayerCount:       10,
    rankingLookbackBlocks: 100_000,
  });

  // Track the latest corp-address list so the scraper always has fresh inputs.
  let latestCorpAddresses: string[] = [];

  // Per-corp headroom alert state — tracks the level we last DM'd for each
  // corp so we don't spam on oscillation. Re-arms only after returning to safe.
  const corpHeadroomLastLevel = new Map<string, 'safe' | 'warn' | 'danger'>();
  async function checkHeadroomAlerts(corpsBlock: any) {
    if (!config.operatorChatId) return;
    // Lazy-import the helper to avoid TS circular import concerns.
    const { computeOpHeadroom } = await import('./feeds/corp-state');
    const ethPrice = engine.getEthPrice();
    if (ethPrice == null) return;
    for (const c of corpsBlock.corps as any[]) {
      const h = computeOpHeadroom(c, ethPrice);
      if (!h) {
        // Op not active — clear stored level so the next active op starts clean.
        corpHeadroomLastLevel.delete(c.address);
        continue;
      }
      const prevLevel = corpHeadroomLastLevel.get(c.address) ?? 'safe';
      // Fire DM only when transitioning INTO danger from a non-danger level.
      // Re-arm when corp returns to 'safe' (so a fresh slide back triggers again).
      if (h.alertLevel === 'danger' && prevLevel !== 'danger') {
        const devSign = h.deviationPct >= 0 ? '+' : '';
        const minLeft = Math.ceil(h.secondsRemaining / 60);
        const text =
          `🚨 *LIQUIDATION RISK*\n` +
          `Corp: \`${c.address.slice(0, 10)}..\` (${c.locationLabel}, ${c.modeLabel})\n` +
          `Headroom: *${h.headroomPct.toFixed(0)}%*\n` +
          `ETH: $${h.ethPrice.toFixed(2)} (anchor $${h.anchorPrice.toFixed(2)}, ` +
          `${devSign}${h.deviationPct.toFixed(3)}% / ±${h.thresholdPct.toFixed(3)}%)\n` +
          `Time left: ${minLeft}m`;
        try { await bot.sendDm(config.operatorChatId, text, { parseMode: 'Markdown' }); }
        catch { /* sendDm swallows errors */ }
      }
      corpHeadroomLastLevel.set(c.address, h.alertLevel);
    }
  }
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

  // On-chain wallet balances (INF / DIRTY / USDM).
  // Cache the latest snapshot so the corp bot's /bot status can surface them
  // without doing its own RPC fetch.
  let latestWalletBalances: import('./feeds/onchain-balances').WalletBalances | null = null;
  balances.on('balances', (b) => {
    engine.onWalletBalances(b);
    latestWalletBalances = b;
  });

  // Per-corp on-chain state (mode, autoTrade, cooldown, pendingReward, ...)
  corps.on('corps', (b) => {
    engine.onCorpState(b);
    // Feed the live address list to the scraper.
    latestCorpAddresses = b.corps.map((c: any) => c.address.toLowerCase());
    // Per-op liquidation headroom DM alerts (Phase 1a).
    // Fires once when a corp first crosses into 'danger' (<25% headroom),
    // then re-arms only after the corp returns to 'safe' (>=50%) — prevents
    // spam during oscillating prices, while still catching repeated risks.
    void checkHeadroomAlerts(b);
  });

  // Live $DIRTY ↔ USDM AMM rate from the in-game Uniswap V3 pool
  amm.on('rate', (r) => engine.onAmmRate(r));

  // Token supply tracking + active player count (Tier A)
  tokenomics.on('tokenomics', (t) => engine.onTokenomics(t));

  // $DIRTY price + history from Kumbaya DEX
  dirtyPrice.on('price', (p) => engine.onDirtyPrice(p));

  // Enterprise loadout state — own + network meta
  loadoutScanner.on('user',    () => engine.onLoadouts(loadoutScanner.getSnapshot()));
  loadoutScanner.on('network', () => engine.onLoadouts(loadoutScanner.getSnapshot()));

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

      // Feed liquidations into the corp bot's circuit breaker — independent
      // of opType classification. Even unknown-type liquidations count as
      // "something failed", which is exactly the signal the breaker watches.
      // Pass the EVENT's timestamp (derived from block delta), NOT Date.now() —
      // critical for correctness when the scraper is backfilling old events
      // after a bot restart. The breaker drops anything older than its window.
      if (!o.succeeded) {
        corpBot.recordLiquidation(o.corp, o.ts, o.txHash);
      }

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
    cachedActivity = buildSummaryBundle(storage, sessionStartMs);
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

  // --- Telegram bot service (Phase 2). No-ops when TELEGRAM_BOT_TOKEN
  //     is unset, so deploying without TG just keeps the dashboard going. ---
  const bot = new TgBot({
    token: config.telegramBotToken,
    storage,
    refLink: config.refLink || undefined,
    operatorChatId: config.operatorChatId,
    dashboardUrl: config.dashboardUrl,
  });
  void bot.start();

  // Multi-tenant per-subscriber alert poller. Iterates registered subscribers'
  // wallets and DMs them on transitions (claim ready, INF low, auto off).
  const subPoller = new SubscriberPoller({
    storage,
    bot,
    pollMs: config.subPollIntervalMs,
  });
  // Only run if the bot is alive AND we have at least the token configured.
  // The poller itself short-circuits when zero subscribers, so it's safe to
  // start unconditionally in PUBLIC_MODE — it just sits idle.
  if (config.telegramBotToken) {
    subPoller.start();
  }

  // Channel broadcaster for market alerts (no-op without channel handle).
  const broadcaster = new Broadcaster({
    bot,
    channelHandle: config.tgChannelUsername,
    refLink: config.refLink || undefined,
  });

  // --- Corp Bot (Drug ↔ Arms auto-switcher + auto-claim) ---
  // Wires the TG bot in so the operator gets a DM on every mode switch / claim.
  const corpBot = new CorpBot({
    corps: [
      // Caribbean L1 (locations 0-2) — active since Day 1
      '0x60290db367cb46f3b0c1b439dbc0fed86aa24f90', // Cayman Islands
      '0x2d6fb5a377d0a6d463c3aea17973609659afd0f0', // British Virgin Islands
      '0x5f1b5afbbf9bed706d1806326479ddd36c8eec4a', // Bermuda
      // L2 region (locations 3-5) — unlocked May 7 via PL2 ($60 USDM unlock)
      '0x103469af1609c2341ae313e6fbfaab56022faa1a',
      '0x35ebd95455aae47b66b4baf10654c34898aefa67',
      '0x67aee1ca6e9b37ccfcbb9d62efd8a6a3f32db49f',
      // L3 region (locations 6-8) — locked behind PL3 (3,600 XP + $250 unlock)
      // '0xf3bbfb854d57abf0cdda5b2a5219f5e2ca026c85',
      // '0xd9552288607fec4c113372f38f78347a050b60de',
      // '0x1e99791a6bd597ff892e0c6ae405b440aa582c7c',
    ],
    tgBot: bot,
    operatorChatId: config.operatorChatId,
    getWalletBalances: () => latestWalletBalances,
  });
  // Give the TG bot a back-reference to the corp bot so the /bot admin
  // command can drive it. Operator-only auth is enforced inside cmdBot.
  bot.attachCorpBot(corpBot);

  // Broadcast state to WS clients every 1s + observe transitions for channel alerts.
  setInterval(() => {
    const state = engine.getState();
    server.broadcast(state);
    broadcaster.observe(state);
    // Feed latest danger score to corp bot
    corpBot.onDangerScore(state.scores.dangerScore);
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
  amm.start();
  tokenomics.start();
  dirtyPrice.start();
  void loadoutScanner.start();
  poly.start();
  cg.start();

  if (config.publicMode) {
    // Public deployment: do not start personal-data feeds. The TG bot service
    // (Phase 2) will handle multi-tenant per-subscriber polling separately.
    logger.info('[PublicMode] Personal feeds (wallet/corps/op-scraper) DISABLED.');
  } else {
    balances.start();
    void corps.start();
    // Wait one second after corps.start() before kicking the scraper so the
    // initial company-list fetch has a chance to resolve.
    setTimeout(() => { void scraper.start(); }, 1500);

    // Corp bot — starts only if BOT_PRIVATE_KEY is set in .env
    corpBot.init().then(ok => { if (ok) corpBot.start(); });
  }

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
  const shutdown = async () => {
    logger.info('[Shutdown] Cleaning up...');
    binance.stop();
    bybit.stop();
    hl.stop();
    hlws.stop();
    balances.stop();
    corps.stop();
    amm.stop();
    tokenomics.stop();
    dirtyPrice.stop();
    loadoutScanner.stop();
    scraper.stop();
    poly.stop();
    cg.stop();
    bot.stop();
    subPoller.stop();
    // CorpBot.stop() is async — wait for any in-flight tx to settle before exiting
    // so we don't broadcast a transaction and exit before tx.wait() completes.
    await corpBot.stop();
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
