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
};
