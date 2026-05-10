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
import { ScheduleEvidenceFeed } from './feeds/schedule-evidence';
import { NetworkHealthFeed } from './feeds/network-health';
import { OpParamsFeed } from './feeds/op-params';
import { WhaleTradesFeed } from './feeds/whale-trades';
import { WhaleClaimsFeed } from './feeds/whale-claims';
import { WhaleCopyFeed } from './feeds/whale-copy';
import { KumbayaLpFeed } from './feeds/kumbaya-lp';
import { DirtyFlowFeed } from './feeds/dirty-flow';
import { PolymarketFeed } from './feeds/polymarket';
import { CoinglassFeed } from './feeds/coinglass';
import { VolatilityEngine } from './engine/volatility';
import { EthVelocitySignal } from './engine/eth-velocity-signal';
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
  // topPlayerCount bumped to 25 so WhaleTradesFeed can track the top-25
  // by ops count. The dashboard's WHALE WATCH panel still renders the
  // first 10 (CSS limit on the rendering side), so widening here only
  // gives the whale-trades feed a bigger pool.
  const loadoutScanner = new LoadoutScannerFeed({
    walletAddress:        config.walletAddress,
    selfPollMs:           60_000,
    networkPollMs:        15 * 60_000,
    topPlayerCount:       25,
    rankingLookbackBlocks: 100_000,
    // Pass storage so the scanner can rank by claim USDM (preferred over
    // ops count). Falls back to ops-based ranking when fewer than 10
    // distinct claimers in the 7d window (i.e. on a fresh deploy).
    storage,
    claimRankWindowMs:    7 * 86400_000,
  });

  // Track the latest corp-address list so the scraper always has fresh inputs.
  let latestCorpAddresses: string[] = [];

  // (Vault + headroom DM alerts were disabled 2026-05-08 — operator
  //  reported "way too loud" during normal volatility. Removed 2026-05-09
  //  dead-code pass. Vault projections + headroom levels still surface on
  //  the dashboard; the circuit-breaker trip notification on actual
  //  liquidations is unaffected.)
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
  });

  // Live $DIRTY ↔ USDM AMM rate from the in-game Uniswap V3 pool
  amm.on('rate', (r) => engine.onAmmRate(r));

  // Token supply tracking + active player count (Tier A)
  tokenomics.on('tokenomics', (t) => engine.onTokenomics(t));

  // $DIRTY price + history from Kumbaya DEX
  dirtyPrice.on('price', (p) => engine.onDirtyPrice(p));

  // Enterprise loadout state — own + network meta
  loadoutScanner.on('user',    () => {
    const snap = loadoutScanner.getSnapshot();
    engine.onLoadouts(snap);
  });
  loadoutScanner.on('network', () => engine.onLoadouts(loadoutScanner.getSnapshot()));

  // On-chain operation outcome scraper. Each newly-finalized
  // TradeCompleted / TradeLiquidated event is written directly to
  // op_outcomes via storage.insertOpOutcome so the empirical
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

      // Attach to whale_copy_log if this outcome lines up with a recent
      // copy-mode bootstrap. No-op when no matching row.
      corpBot.recordOpOutcome({
        corp: o.corp,
        succeeded: o.succeeded,
        dirtyEarned: o.rewardDirty,
        ts: o.ts,
      });

      if (o.opType === 'unknown') {
        logger.warn({ txHash: o.txHash, durationMin: o.durationMin, mode: o.mode },
          '[OpScraper] outcome with unknown opType; not logging');
        return;
      }

      // Direct storage insert. Replaced the previous self-HTTP POST to
      // `/api/op-result` (which routed through Fastify schema validation
      // and the operator gate). Same end result — insertOpOutcome — but
      // without the network round-trip + serialization + double-bookkeeping
      // failure modes.
      try {
        const base = o.baseReward ?? 100;
        // Sanity clamp mirrors the API endpoint's check so anomalous events
        // (chain quirks, decode bugs) don't poison the empirical SR sample.
        if (o.rewardDirty > base * 2) {
          logger.warn(
            { txHash: o.txHash, dirtyEarned: o.rewardDirty, baseReward: base },
            '[OpScraper] dropping outcome — dirtyEarned > 2× base (likely decode anomaly)',
          );
          return;
        }
        // Strategy attribution: look up the bootstrap_log row that fired
        // this op (matched by corp + ts within ~95min — covers Drug 90m
        // + slack). NULL when no match (legacy op, contract auto-restart,
        // or operator UI startTrade — all expected occasionally).
        const bootstrap = storage.findBootstrapForOutcome(o.corp, o.ts);
        // INF cost at outcome time — pulled from op_params live snapshot.
        // This is "cost when settled", not "cost when bootstrapped". For
        // attribution it's close enough since the price floats slowly.
        const opSnap = opParams.getSnapshot();
        const infCost = opSnap?.infCostPerOp ?? null;

        storage.insertOpOutcome({
          ts: o.ts,
          opType: o.opType,
          succeeded: o.succeeded ? 1 : 0,
          dirtyEarned: o.rewardDirty,
          baseReward: base,
          note: `auto:${o.txHash.slice(0, 12)}...:${o.corp.slice(0, 8)}:m${o.mode}`,
          strategy: bootstrap?.strategy ?? null,
          corp: o.corp,
          infCost,
        });
        // Recompute cached op stats for the next dashboard broadcast.
        onOpStatsChanged();
        logger.info(
          { op: o.opType, reward: o.rewardDirty, succeeded: o.succeeded, corp: o.corp.slice(0, 10) },
          '[OpScraper] auto-logged outcome',
        );
      } catch (err: any) {
        logger.error({ err: err.message, txHash: o.txHash }, '[OpScraper] insertOpOutcome failed');
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
  // Multi-tenant wallet tracker — powers /api/track/:wallet for FlowDirty.fun.
  // Reuses operator's cycle metadata + ETH price feed (no extra background load).
  const { WalletTracker } = await import('./feeds/wallet-tracker');
  const walletTracker = new WalletTracker({
    loadoutScanner,
    getEthPrice: () => engine.getEthPrice(),
  });

  // Schedule-evidence feed — daily network-wide ops scan, persists hourly
  // rollups for the dashboard's "best/worst hours" panel.
  const scheduleEvidence = new ScheduleEvidenceFeed({ storage });

  // OpParamsFeed — live-samples the contract's current liquidation
  // thresholds every 10 min. Drives danger calculations + UI displays.
  // Replaces the old hardcoded constants (which went stale when devs
  // recalibrated leverage on 2026-05-09 and added weekend mode).
  const opParams = new OpParamsFeed({ storage });
  engine.setOpParamsProvider(() => opParams.getSnapshot());

  // WhaleTradesFeed — tracks every DIRTY transfer involving a top-25
  // network player, classified by counterparty (DEX swap / asset buy /
  // op payout / mint / burn / whale-to-whale). Operator-only intel
  // panel; not exposed on the public surface.
  const whaleTrades = new WhaleTradesFeed({
    storage,
    loadoutScanner,
    topN: 25,
    getDirtyPriceUsd: () => {
      // Best available DIRTY/USD: prefer KumbayaPriceFeed's priceUSD field.
      // Fall back to live AMM rate × ETH spot if Kumbaya is stale. The
      // KumbayaPriceFeed serializes the field as `priceUSD` (capital
      // letters) — a previous version of this getter used `priceUsd`
      // (camelCase) which always returned undefined and caused all
      // whale-trade USD values to default to 0.
      const dp = engine.getState().dirtyPrice as any;
      return dp?.priceUSD ?? null;
    },
  });
  engine.setWhaleTradesProvider(() => whaleTrades.getSnapshot());

  // WhaleClaimsFeed — every CycleRewards claim() event. Operator-only
  // intel showing which whales actually harvest USDM per cycle.
  const whaleClaims = new WhaleClaimsFeed({ storage, loadoutScanner });

  // KumbayaLpFeed — Mint/Burn/Collect on the DIRTY/USDM pool.
  // Liquidity-shift signal that affects DIRTY price stability.
  const kumbayaLp = new KumbayaLpFeed({ storage });

  // DirtyFlowFeed — hourly DIRTY Transfer scan, bucketed by counterparty
  // (mint/burn/DEX-sell/DEX-buy/router-sell/router-buy/peer). Drives the
  // DIRTY HEALTH dashboard tile that tells the operator whether the
  // network is currently in net buy or sell pressure.
  const dirtyFlow = new DirtyFlowFeed({ storage });

  // WhaleCopyFeed — re-uses the LoadoutScanner's `topBySr` pool (top 5 by
  // 72h SR with min 50 ops + 75% SR), polls those whales' corps every 30s,
  // emits an event whenever any of their corps transitions idle → active.
  // CorpBot subscribes via setCopyHooks below.
  const whaleCopy = new WhaleCopyFeed({ loadoutScanner });

  engine.setWhaleClaimsProvider(() => whaleClaims.getSnapshot());
  engine.setKumbayaLpProvider(() => kumbayaLp.getSnapshot());
  engine.setStorageProvider(storage);

  // ── Danger-v2 leading-indicator signals ──
  // Both default to SHADOW mode (compute & log only, no bot pause). Flip
  // via env once defense_shadow_log shows good precision/recall.
  const networkHealth = new NetworkHealthFeed({
    storage,
    shadow: config.networkHealthShadow,
  });
  const ethVelocity = new EthVelocitySignal({
    storage,
    engine,
    shadow: config.ethVelocityShadow,
  });
  // Wire snapshot providers into the volatility engine so the composite
  // dangerScore can incorporate the new signals.
  engine.setDangerV2Providers(
    () => networkHealth.getSnapshot(),
    () => ethVelocity.getSnapshot(),
  );

  const server = new ApiServer(
    storage,
    () => engine.getState(),
    onOpStatsChanged,
    walletTracker,
    scheduleEvidence,
    dirtyFlow,
    // Schedule auditor reads the live 24-element preset array. Closure
    // — picks up runtime edits via /bot schedule without a restart.
    () => corpBot.getSchedule(),
  );

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
    // Used by /bot burn-money to surface live OpParamsFeed thresholds.
    getState: () => engine.getState(),
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
    storage,                           // for SafetyGate shadow logging
  });
  // Wire copy-mode hooks. Pool mean SR comes from WhaleCopyFeed; network
  // rolling SR is read from ScheduleEvidence's 7d rolling stats. Both
  // are getters so the bot picks up live values each tick.
  corpBot.setCopyHooks({
    drainQueue: () => whaleCopy.drainQueue(),
    getPoolMeanSr: () => whaleCopy.getPoolMeanSr(),
    getNetworkSr: () => {
      try {
        const r = scheduleEvidence.getRollingStats(7);
        return r.globalSR;
      } catch { return null; }
    },
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
    // Feed per-op safety scores (powers the SafetyGate shadow check)
    corpBot.onSafetyScores({
      extortion: state.scores.extortion ?? null,
      arms:      state.scores.arms      ?? null,
      drug:      state.scores.drug      ?? null,
    });
  }, 1000);

  // DB cleanup hourly
  setInterval(() => {
    storage.cleanup();
  }, config.cleanupInterval);

  // ── Daily digest scheduler (broadcast channel) ──
  // Fires once per UTC day at 01:00 UTC = 09:00 HKT. Checks every minute
  // and tracks last-fired-day so we never double-fire and never miss a
  // day across pm2 restarts.
  let lastDigestDate: string | null = null;
  // Schedule audit alert dedup: per-slot key → { date sent, last delta_pct }
  // so we don't ping the operator about the same slot two days in a row
  // unless it got materially worse.
  const lastAuditAlerts = new Map<string, { date: string; deltaPct: number }>();
  setInterval(async () => {
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const todayKey = now.toISOString().slice(0, 10);
    // Window: 01:00–01:04 UTC. Stash last-fired-date so a restart at 01:02
    // doesn't re-fire if we already fired this day.
    if (hour === 1 && minute < 5 && lastDigestDate !== todayKey) {
      try {
        const text = broadcaster.composeDailyDigest({
          state: engine.getState(),
          rolling7d: scheduleEvidence.getRollingStats(7),
          // Vault USDM pool — null until we wire the multicall feed
          // (see follow-up). Skip the line in the digest if null.
          vaultPoolUsdm: null,
        });
        await broadcaster.postDailyDigest(text);
        lastDigestDate = todayKey;
        logger.info({ date: todayKey }, '[Broadcaster] daily digest sent');
      } catch (err: any) {
        logger.warn({ err: err.message }, '[Broadcaster] daily digest failed');
      }

      // Schedule audit DM — runs alongside the digest. Pulls the last 48h
      // of slot performance and DMs the operator about any slot
      // underperforming Drug by >15% with sample ≥10 ops. Per-slot dedup
      // prevents two-days-in-a-row pings unless the slot got worse.
      try {
        if (config.operatorChatId) {
          const { computeScheduleAudit } = await import('./engine/efficiency');
          const audit = computeScheduleAudit(storage, corpBot.getSchedule(), {
            windowHours: 48,
            minOpsForFlag: 10,
            underperfThreshold: 15,
          });
          const flagged = audit.audit.filter(r =>
            r.flag === 'underperforming' &&
            r.delta_pct != null &&
            r.delta_pct < -15 &&
            r.actual_ops >= 10,
          );
          for (const r of flagged) {
            const key = `${r.hkt_hour}|${r.regime}|${r.scheduled_preset}`;
            const prev = lastAuditAlerts.get(key);
            // Only re-alert if either: (a) we never sent for this slot,
            // (b) >2 days passed since last alert, OR (c) delta worsened
            // by >5pp since last alert.
            const daysSince = prev
              ? (Date.parse(todayKey) - Date.parse(prev.date)) / 86400_000
              : Infinity;
            const worsened = prev && r.delta_pct < prev.deltaPct - 5;
            if (!prev || daysSince > 2 || worsened) {
              const txt =
                `⚠️ *Schedule slot underperforming*\n\n` +
                `HKT ${String(r.hkt_hour).padStart(2,'0')}:00 ${r.regime} *${r.scheduled_preset}*\n` +
                `→ actual: *${r.actual_dirty_per_inf.toFixed(2)} DIRTY/INF* (n=${r.actual_ops})\n` +
                `→ all-Drug baseline at this hour: *${r.baseline_drug_dirty_per_inf!.toFixed(2)}*\n` +
                `→ delta: *${r.delta_pct!.toFixed(1)}%* below baseline\n\n` +
                `Consider: \`/bot schedule ${r.hkt_hour} all-drug\``;
              try {
                await bot.sendDm(config.operatorChatId, txt, { parseMode: 'Markdown' });
                lastAuditAlerts.set(key, { date: todayKey, deltaPct: r.delta_pct });
                logger.info({ slot: key, delta: r.delta_pct }, '[ScheduleAudit] alert sent');
              } catch (err: any) {
                logger.warn({ err: err.message, slot: key }, '[ScheduleAudit] DM failed');
              }
            }
          }
        }
      } catch (err: any) {
        logger.warn({ err: err.message }, '[ScheduleAudit] daily check failed');
      }
    }
  }, 60_000).unref();

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
  void scheduleEvidence.start();
  void opParams.start();
  void whaleTrades.start();
  void whaleClaims.start();
  void kumbayaLp.start();
  void dirtyFlow.start();
  void whaleCopy.start();
  if (!config.networkHealthDisabled) void networkHealth.start();
  if (!config.ethVelocityDisabled)   ethVelocity.start();
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
    scheduleEvidence.stop();
    opParams.stop();
    whaleTrades.stop();
    whaleClaims.stop();
    kumbayaLp.stop();
    dirtyFlow.stop();
    whaleCopy.stop();
    networkHealth.stop();
    ethVelocity.stop();
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
