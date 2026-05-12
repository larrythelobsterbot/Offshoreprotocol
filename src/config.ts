import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000'),
  // Default to loopback. Public deploys must explicitly set HOST=0.0.0.0 in .env.
  // Anything non-loopback is required to also set OPERATOR_API_TOKEN before
  // mutating endpoints will accept writes (see api/server.ts).
  host: process.env.HOST || '127.0.0.1',
  logLevel: process.env.LOG_LEVEL || 'info',
  // Operator API token. Required for write endpoints when host is non-loopback
  // and PUBLIC_MODE is false. Generate with `openssl rand -hex 32`.
  operatorApiToken: (process.env.OPERATOR_API_TOKEN || '').trim(),
  // Allowed dashboard origins for CORS. Comma-separated. Empty = same-origin only.
  // Defaults include localhost dev origins + the public dashboard URL.
  corsOrigins: (process.env.CORS_ORIGINS || '').trim(),

  coinglassApiKey: process.env.COINGLASS_API_KEY || '',
  polymarketTokenId: process.env.POLYMARKET_TOKEN_ID || '',

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  alertDangerHigh: parseInt(process.env.ALERT_DANGER_HIGH || '60'),
  alertDangerLow: parseInt(process.env.ALERT_DANGER_LOW || '25'),
  alertCooldownMinutes: parseInt(process.env.ALERT_COOLDOWN_MINUTES || '15'),

  dataRetentionDays: parseInt(process.env.DATA_RETENTION_DAYS || '30'),

  studentTDf: parseInt(process.env.STUDENT_T_DF || '4'),

  // Player wallet for on-chain balance reads (MegaETH mainnet).
  // Leave empty to disable the on-chain balance feed.
  walletAddress: process.env.WALLET_ADDRESS || '',
  onchainPollInterval: parseInt(process.env.ONCHAIN_POLL_MS || '15000'),

  // Public deployment mode: hide the operator's personal wallet/corp/op
  // data from the dashboard so it can be advertised as a market-intel
  // tool. Personal feeds are not started; only market feeds run. The
  // Telegram bot service handles per-subscriber personal alerts instead.
  publicMode: process.env.PUBLIC_MODE === 'true',
  // Username of the Telegram bot users should subscribe to. Used in the
  // public-mode hero CTA. Format: 'offshoreopsbot' (no @ prefix).
  tgBotUsername: process.env.TG_BOT_USERNAME || '',
  // Optional: a public Telegram channel handle to direct visitors to.
  tgChannelUsername: process.env.TG_CHANNEL_USERNAME || '',
  // Operator's referral link for the game, surfaced via the bot's /ref command.
  refLink: process.env.OFFSHORE_REF_LINK || '',
  // Operator's TG user ID — receives admin pings (e.g. new subscriber notification).
  // Optional. When unset, admin pings are no-op.
  // Strict integer validation: parseInt('123abc') silently returns 123, so we
  // require the env var to be a clean integer string (positive or negative)
  // before accepting it. Anything malformed becomes null and disables DMs.
  operatorChatId: (() => {
    const raw = (process.env.TG_OPERATOR_CHAT_ID || '').trim();
    if (!/^-?\d+$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n !== 0 ? n : null;
  })(),
  // Public dashboard URL surfaced via /help and channel alerts.
  dashboardUrl: process.env.DASHBOARD_URL || 'https://offshore.lekker.design',
  // Subscriber poller cadence (multi-tenant, per-subscriber alert checks).
  subPollIntervalMs: parseInt(process.env.SUB_POLL_MS || '30000'),

  // Polling intervals (ms)
  hlPollInterval: 30_000,
  polyPollInterval: 10_000,
  cgPollInterval: 60_000,
  indicatorStoreInterval: 30_000,
  cleanupInterval: 3600_000, // hourly

  // ── Danger v2 / op-spacing config ──
  // Minimum minutes between consecutive corp bootstrap startTrade calls.
  // 0 = current behavior (all corps fire as soon as eligible — high
  // correlation). 15 = recommended (6 corps × 90min Drug ops perfectly
  // staggered). Variance reducer; EV-neutral.
  botStaggerMin: parseInt(process.env.BOT_STAGGER_MIN || '10'),
  // When true (default), the stagger interval adapts to the active corp
  // count so the whole fleet bootstraps inside one Drug-deal duration
  // (~90 min). See CorpBot.getStaggerMinutes for the bucket table. Set
  // to false to pin the gate at botStaggerMin always.
  botStaggerAuto: (process.env.BOT_STAGGER_AUTO ?? 'true').toLowerCase() !== 'false',

  // ── Graduated corp scaling ──
  // Instead of binary all-on / all-off based on the danger override,
  // scale the number of active corps with the danger score so the
  // fleet contracts BEFORE a full panic and expands once danger fades.
  // Levels are parsed from BOT_GRADUATED_LEVELS as "danger:corps" pairs,
  // comma-separated, ascending by danger threshold. Default:
  //   <40   → all corps active
  //   ≥40   → 6 corps   (Elevated)
  //   ≥60   → 3 corps   (High)
  //   ≥75   → 0 corps   (Critical — equivalent to the existing panic preset)
  // The 0-corps level is functionally identical to panic/breaker pausing
  // — graduated scaling is purely the IN-BETWEEN levels (40-75).
  botGraduatedScaling: (process.env.BOT_GRADUATED_SCALING ?? 'true').toLowerCase() !== 'false',
  botGraduatedLevels:  process.env.BOT_GRADUATED_LEVELS  ?? '40:6,60:3,75:0',
  // Hysteresis (points) — once scaled DOWN to level N at danger threshold T,
  // require danger to drop to T - hysteresis before scaling BACK UP. Prevents
  // thrashing when danger hovers near a threshold.
  botGraduatedHysteresis: parseInt(process.env.BOT_GRADUATED_HYSTERESIS ?? '5'),
  // Which corps to pause first when scaling down. 'newest' pauses L3 corps
  // first (operator preference — L1 has the longest track record and the
  // most XP invested). 'oldest' reverses for testing / comparison.
  botGraduatedPriority: (process.env.BOT_GRADUATED_PRIORITY ?? 'newest').toLowerCase() as 'newest' | 'oldest',

  // ── NetworkHealth → graduated penalty ──────────────────────────
  // When the NH signal trips (cascade / drug / arms critical), bump
  // the effective danger score that the graduated scaling layer reads.
  // Penalty is FULL for 0-15min after trip then linearly fades to 0
  // at 90min (matching the empirical fail-rate fade curve from the
  // 24h shadow data: 67% in 0-15min → 0% past 90min).
  //
  // Rationale: NH is predictive (clean signal) but BLOCKING ops is
  // net-negative (-$232/day per shadow counterfactual) because Drug
  // partial payouts on failure offset the saved INF. Scaling DOWN
  // captures most of the protection while keeping partials flowing.
  //
  // Default penalty 25 = "one graduated level":
  //   normal (30) + 25 = 55 → elevated (6 corps from 9)
  //   elevated (50) + 25 = 75 → critical (full pause)
  botNhDangerPenalty:  parseInt(process.env.BOT_NH_DANGER_PENALTY ?? '25'),
  botNhFullMinutes:    parseInt(process.env.BOT_NH_FULL_MINUTES   ?? '15'),
  botNhFadeMinutes:    parseInt(process.env.BOT_NH_FADE_MINUTES   ?? '90'),
  // Shadow first — log what the penalty WOULD do without applying.
  // Flip to false after validating the counterfactual P&L over 24-48h.
  botNhGraduatedShadow: (process.env.BOT_NH_GRADUATED_SHADOW ?? 'true').toLowerCase() !== 'false',

  // ── Hedge activation policy (conditional opening) ──────────────
  // Decides when HedgeBot should ATTEMPT to open a hedge. Independent
  // of the shadow/live mode setting — the policy determines whether
  // a hedge would fire at all, the mode decides whether the order is
  // actually placed on World.
  //
  //   'danger-only' (default) — fire whenever effective danger ≥ minDanger
  //   'us-hours'              — only during US market hours HKT 22-04
  //   'always'                — every batch, regardless of conditions
  //   'off'                   — never (equivalent to disabling hedge)
  hedgeActivationPolicy: (process.env.HEDGE_ACTIVATION_POLICY ?? 'danger-only').toLowerCase(),
  hedgeMinDanger:        parseInt(process.env.HEDGE_MIN_DANGER ?? '40'),
  hedgeMinCorps:         parseInt(process.env.HEDGE_MIN_CORPS  ?? '6'),
  hedgeRequireRedstone:  (process.env.HEDGE_REQUIRE_REDSTONE ?? 'true').toLowerCase() !== 'false',
  hedgeMaxMargin:        parseFloat(process.env.HEDGE_MAX_MARGIN ?? '3000'),
  // 'contract' reads liqPrice from the corp after startTrade() confirms
  // (guaranteed-aligned TP). 'computed' falls back to RedStone × (1-threshold).
  hedgeTpSource:        (process.env.HEDGE_TP_SOURCE ?? 'contract').toLowerCase() as 'contract' | 'computed',

  // Shadow-mode flags for danger-v2 signals. true = compute & log only,
  // do NOT actually pause the bot. Flip to false once precision/recall
  // looks good in defense_shadow_log.
  networkHealthShadow: (process.env.NETWORK_HEALTH_SHADOW ?? 'true').toLowerCase() !== 'false',
  ethVelocityShadow:   (process.env.ETH_VELOCITY_SHADOW   ?? 'true').toLowerCase() !== 'false',
  // Hard kill switches (skip the signal entirely, even shadow logging).
  networkHealthDisabled: process.env.NETWORK_HEALTH_DISABLED === '1',
  ethVelocityDisabled:   process.env.ETH_VELOCITY_DISABLED   === '1',

  // ── Safety Gate (per-op safety score gate before bootstrap) ──
  // Runs BEFORE startTrade(). When score for the chosen op type is below
  // its threshold, the gate either logs a "would-block" shadow event
  // (default) or actually skips the bootstrap (when shadow=false).
  // Per-op thresholds — 0 disables that op type entirely.
  // Defaults are calibrated from the 324-op alpha analysis (2026-05-09):
  //   Drug at safety<50 = 60% SR vs Drug at safety>=50 = 68% SR (modest gate)
  //   Drug at safety<25 was n=5 only — tiny sample, treat as disabled
  //   Arms calibration is unreliable above safety=75 (n=4, 50% observed
  //     vs 84% predicted) — keep gate OFF until we have more data
  //   Extortion is operator-confirmed only via burn-money — gate OFF
  safetyGateShadow: (process.env.SAFETY_GATE_SHADOW ?? 'true').toLowerCase() !== 'false',
  safetyGateDisabled: process.env.SAFETY_GATE_DISABLED === '1',
  safetyGateDrugThreshold: parseFloat(process.env.SAFETY_GATE_DRUG_THRESHOLD ?? '50'),
  safetyGateArmsThreshold: parseFloat(process.env.SAFETY_GATE_ARMS_THRESHOLD ?? '0'),
  safetyGateExtThreshold:  parseFloat(process.env.SAFETY_GATE_EXT_THRESHOLD  ?? '0'),

  // ── Operator override grace period (Fix B) ──
  // When a corp shows autoTradeEnabled=false but the bot's active preset
  // is NOT paused (so the bot didn't disable it itself), grant the
  // operator this many minutes of "I'm doing something manually" grace
  // before the bot re-enables. Set to 0 to disable grace (legacy
  // behavior — bot re-enables within 30s). Set to a high value to be
  // very forgiving. Recommended 5–15 min.
  botOperatorGraceMin: parseInt(process.env.BOT_OPERATOR_GRACE_MIN ?? '5'),

  // ── Threshold-Cliff Defense (Layer 2: bot gate + Layer 3: TG alert) ──
  // Catches contract leverage recalibrations + ETH velocity regimes where
  // bootstrapping is near-certain liquidation. Per Codex audit 2026-05-11
  // notes: underlying probDrug math is one-sided downside, but calibrateProb
  // empirically corrects against (symmetric) historical fail rates, so the
  // calibrated value is the right signal — at canonical thresholds. At
  // sharply tighter live thresholds the calibration is OOD; gate decisions
  // are logged to defense_shadow_log for post-hoc validation.
  //
  // Layer 2 gate — Drug only initially (operator runs Drug ~100%).
  // Hysteresis: block when p(fail) crosses BLOCK upward, only clear when
  // it crosses CLEAR downward. Prevents bootstrap-thrash at the boundary.
  // Defaults chosen from PL2 economics at $0.099/DIRTY:
  //   win  EV ≈ +$11.39 (115 DIRTY)   fail EV ≈ -$10.71 (10 DIRTY partial - $11.70 INF)
  //   break-even P(fail) ≈ 51.5%
  // Block @0.55 leaves only 3.5pp margin; safe with hysteresis.
  thresholdCliffShadow:        (process.env.THRESHOLD_CLIFF_SHADOW ?? 'true').toLowerCase() !== 'false',
  thresholdCliffDisabled:       process.env.THRESHOLD_CLIFF_DISABLED === '1',
  maxPFailDrugBlock: parseFloat(process.env.MAX_PFAIL_DRUG_BLOCK   ?? '0.55'),
  maxPFailDrugClear: parseFloat(process.env.MAX_PFAIL_DRUG_CLEAR   ?? '0.45'),
  // Staleness ceiling — if last op_params sample is older than this many
  // minutes, the gate treats data as missing and fails safe (blocks Drug
  // bootstraps in live mode; logs in shadow). 10min cadence + jitter.
  opParamsMaxAgeMin: parseInt(process.env.OP_PARAMS_MAX_AGE_MIN ?? '25'),
  // Minimum sample count for threshold to be trusted. Below this, the
  // sample is too thin to act on (e.g. n=1 single corp seen network-wide).
  opParamsMinSamples: parseInt(process.env.OP_PARAMS_MIN_SAMPLES ?? '3'),
  // Layer 3 TG alert — fires when persisted threshold drops by this fraction
  // within ALERT_WINDOW_MIN. 0.15 = 15% tightening triggers.
  thresholdDropAlertPct:  parseFloat(process.env.THRESHOLD_DROP_ALERT_PCT  ?? '0.15'),
  thresholdDropWindowMin: parseInt(process.env.THRESHOLD_DROP_WINDOW_MIN ?? '60'),
  thresholdDropCooldownMin: parseInt(process.env.THRESHOLD_DROP_COOLDOWN_MIN ?? '60'),
  // Only fire alert when absolute new threshold is dangerous (below this
  // value). Prevents alerts on harmless tightening from 1.0% → 0.7%.
  thresholdDropAbsCeilingPct: parseFloat(process.env.THRESHOLD_DROP_ABS_CEILING_PCT ?? '0.0030'),

  // ── RedStone ETH/USD oracle feed ──
  // The on-chain price feed that Offshore Protocol corp contracts
  // actually consult for liquidations on MegaETH. Lives at
  // 0xc555c100db24df36d406243642c169cc5a937f09 (confirmed 2026-05-11
  // via on-chain trace; description() returns "RedStone Price Feed
  // for ETH"). The bot still uses Hyperliquid as the primary tick
  // source — this feed runs in parallel for divergence analysis.
  redstoneOracleAddress: (process.env.REDSTONE_ORACLE_ADDRESS
    || '0xc555c100db24df36d406243642c169cc5a937f09').trim(),
  redstonePollMs: parseInt(process.env.REDSTONE_POLL_MS ?? '3000'),
  redstoneStaleThresholdS: parseInt(process.env.REDSTONE_STALE_THRESHOLD_S ?? '120'),
  // Divergence alert threshold — fires a TG DM when |RS − HL| crosses
  // this many bps AND RedStone is below HL (game more bearish) AND
  // at least one Drug op is live. 15 bps = 0.15%, roughly one Drug
  // threshold-width on a calm day. Set to a higher value (e.g. 30) to
  // mute during low-stakes periods.
  redstoneDivergenceAlertBps: parseFloat(process.env.REDSTONE_DIVERGENCE_ALERT_BPS ?? '15'),
  // Cooldown between divergence alerts. Spike events tend to cluster
  // (oracle relayer hiccup → multiple consecutive samples breach),
  // so a 10-min cooldown prevents alert spam.
  redstoneDivergenceAlertCooldownMin:
    parseInt(process.env.REDSTONE_DIVERGENCE_ALERT_COOLDOWN_MIN ?? '10'),
  // Hard kill switch.
  redstoneDisabled: process.env.REDSTONE_DISABLED === '1',

  // ── World Exchange hedge framework (Phase 1: shadow only) ──
  // The Exchange + ETH perp book addresses come from the operator
  // (no programmatic discovery — see docs/world-sdk-notes.md).
  // Bot stays in shadow until POC + sizing math are both validated.
  worldExchangeAddress: (process.env.WORLD_EXCHANGE_ADDRESS || '').trim(),
  worldEthPerpBook:     (process.env.WORLD_ETH_PERP_BOOK   || '').trim(),
  // World's documented max leverage on ETH-perp at brief writing.
  worldHedgeLeverage: parseInt(process.env.WORLD_HEDGE_LEVERAGE ?? '10'),
  // Hard cap on margin per hedge. Sizing > cap → skip, log warn.
  // 500 USDM at 9 corps + 12 INF/op + 0.4% threshold = $2,700 notional
  // = $270 margin. So 500 leaves significant headroom while still
  // capping any sizing-math bug at $500 loss in live mode.
  worldMaxMarginUsdm:  parseFloat(process.env.WORLD_MAX_MARGIN ?? '500'),
  // Don't hedge below this many corps — sub-PL3 portfolios pay more
  // in fees than they save on small-batch INF loss.
  worldMinCorpsForHedge: parseInt(process.env.WORLD_MIN_CORPS ?? '6'),
  // Default to shadow. Flip via /bot hedge live (with confirm) only
  // after the POC has been run + dashboard shadow stats look right.
  worldHedgeShadow: (process.env.WORLD_HEDGE_SHADOW ?? 'true').toLowerCase() !== 'false',
  // Hard kill switch — turns off the whole module (no shadow logging either).
  worldHedgeDisabled: process.env.WORLD_HEDGE_DISABLED === '1',
  // Seconds to wait after the FIRST corp bootstraps before firing the
  // hedge. Lets stagger-gated bootstraps cluster into a single hedge.
  // CorpBot's stagger gate defaults to 15min, but in practice batches
  // resolve faster on a busy schedule. 120s is a safe initial value.
  worldHedgeBatchDelayS: parseInt(process.env.WORLD_HEDGE_BATCH_DELAY_S ?? '120'),
  // Estimated USDM per trade for shadow-log accounting. Brief notes
  // a $10 max-fee cap on ETH-perp; we use that as the worst-case
  // estimate until we have real fills from the POC.
  worldHedgeFeeEstimateUsdm: parseFloat(process.env.WORLD_HEDGE_FEE_USDM ?? '10'),
};
