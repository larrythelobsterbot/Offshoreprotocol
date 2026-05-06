import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000'),
  host: process.env.HOST || '0.0.0.0',
  logLevel: process.env.LOG_LEVEL || 'info',

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

  // Polling intervals (ms)
  hlPollInterval: 30_000,
  polyPollInterval: 10_000,
  cgPollInterval: 60_000,
  indicatorStoreInterval: 30_000,
  cleanupInterval: 3600_000, // hourly
};
