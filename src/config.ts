import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000'),
  host: process.env.HOST || '0.0.0.0',

  coinglassApiKey: process.env.COINGLASS_API_KEY || '',
  polymarketTokenId: process.env.POLYMARKET_TOKEN_ID || '',

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  alertDangerHigh: parseInt(process.env.ALERT_DANGER_HIGH || '60'),
  alertDangerLow: parseInt(process.env.ALERT_DANGER_LOW || '25'),
  alertCooldownMinutes: parseInt(process.env.ALERT_COOLDOWN_MINUTES || '15'),

  dataRetentionDays: parseInt(process.env.DATA_RETENTION_DAYS || '30'),

  // Operation thresholds (leverage-derived max drop %)
  thresholds: {
    extortion: parseFloat(process.env.EXTORTION_THRESHOLD || '0.17'),
    arms: parseFloat(process.env.ARMS_THRESHOLD || '0.71'),
    drug: parseFloat(process.env.DRUG_THRESHOLD || '2.0'),
  },

  // Operation time windows in minutes
  windows: {
    extortion: parseInt(process.env.EXTORTION_WINDOW_MIN || '5'),
    arms: parseInt(process.env.ARMS_WINDOW_MIN || '30'),
    drug: parseInt(process.env.DRUG_WINDOW_MIN || '90'),
  },

  // Polling intervals (ms)
  hlPollInterval: 30_000,
  polyPollInterval: 10_000,
  cgPollInterval: 60_000,
  indicatorStoreInterval: 30_000,
  cleanupInterval: 3600_000, // hourly

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Student-t distribution degrees of freedom
  studentTDf: parseInt(process.env.STUDENT_T_DF || '4'),
};
