import { config } from '../config';
import type { AlertEvent } from '../types';
import { logger } from '../logger';

const TG_API = 'https://api.telegram.org';

export async function sendTelegramAlert(alert: AlertEvent) {
  if (!config.telegramBotToken || !config.telegramChatId) return;

  try {
    const url = `${TG_API}/bot${config.telegramBotToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: alert.message,
        parse_mode: 'HTML',
      }),
    });
    logger.info({ alertType: alert.type }, 'Telegram alert sent');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Telegram send failed');
  }
}
