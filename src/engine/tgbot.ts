// ============================================================
// Telegram bot service.
//
// Long-polls the Bot API getUpdates endpoint, parses commands sent
// to the bot, and dispatches them. Handles subscription lifecycle:
//
//   /start [refcode]     register subscriber (captures attribution)
//   /wallet 0x...        bind a wallet for personal alerts
//   /wallet remove       unbind wallet
//   /alerts on|off       global toggle
//   /status              current state for this subscriber
//   /ref                 surface the operator's referral link
//   /help                list commands
//
// The bot does NOT block the rest of the engine. If TELEGRAM_BOT_TOKEN
// is unset, the service no-ops (logs once at startup and exits).
//
// Sending DMs to subscribers and broadcast messages to the channel
// goes through telegram.ts helpers; this module only handles incoming
// commands and persists subscriber state.
// ============================================================

import { logger } from '../logger';
import type { Storage } from '../storage/db';

const TG_API_BASE = 'https://api.telegram.org/bot';
const POLL_TIMEOUT_SEC = 30; // long-poll up to 30s
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string };
  text?: string;
  entities?: { type: string; offset: number; length: number }[];
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: any;
}

export interface TgBotConfig {
  token: string;                  // TELEGRAM_BOT_TOKEN
  storage: Storage;
  // Operator's referral link (URL or game-internal code) shown via /ref
  refLink?: string;
  // Optional operator ID to receive admin-style messages (e.g. new subscriber pings)
  operatorChatId?: number | null;
  // Where the dashboard lives — surfaced via /help
  dashboardUrl?: string;
}

export class TgBot {
  private cfg: TgBotConfig;
  private alive = false;
  private offset = 0;
  private stopped = false;
  private botUsername: string | null = null;
  // Inbound message rate limiter — reject command floods from one user.
  private recentCmdCount = new Map<number, { count: number; windowStart: number }>();

  constructor(cfg: TgBotConfig) {
    this.cfg = cfg;
  }

  get connected() { return this.alive; }
  get username() { return this.botUsername; }

  async start() {
    if (!this.cfg.token) {
      logger.info('[TgBot] No TELEGRAM_BOT_TOKEN set; bot service disabled.');
      return;
    }
    // Verify the token by calling getMe and capture the bot's @username
    try {
      const me = await this.api('getMe', {});
      this.botUsername = me.username;
      this.alive = true;
      logger.info({ username: this.botUsername }, '[TgBot] Connected');
    } catch (err: any) {
      logger.error({ err: err.message }, '[TgBot] getMe failed; bot disabled');
      return;
    }
    void this.pollLoop();
  }

  stop() {
    this.stopped = true;
    this.alive = false;
  }

  // ---- HTTP helpers ----

  private async api(method: string, params: Record<string, any>): Promise<any> {
    const url = `${TG_API_BASE}${this.cfg.token}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = await res.json() as any;
    if (!json.ok) throw new Error(`Telegram API ${method}: ${json.description || res.status}`);
    return json.result;
  }

  /** Public helper: send a DM (used by per-subscriber alert poller). */
  async sendDm(chatId: number, text: string, opts: { parseMode?: 'Markdown' | 'HTML' } = {}): Promise<void> {
    if (!this.alive) return;
    try {
      await this.api('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: opts.parseMode ?? 'Markdown',
        disable_web_page_preview: true,
      });
    } catch (err: any) {
      logger.warn({ err: err.message, chatId }, '[TgBot] sendDm failed');
    }
  }

  /** Public helper: broadcast to a channel (e.g. @offshorecasinochannel). */
  async sendChannel(channelHandle: string, text: string, opts: { parseMode?: 'Markdown' | 'HTML' } = {}): Promise<void> {
    if (!this.alive) return;
    try {
      await this.api('sendMessage', {
        chat_id: channelHandle.startsWith('@') ? channelHandle : '@' + channelHandle,
        text,
        parse_mode: opts.parseMode ?? 'Markdown',
        disable_web_page_preview: true,
      });
    } catch (err: any) {
      logger.warn({ err: err.message, channelHandle }, '[TgBot] sendChannel failed');
    }
  }

  // ---- Long-poll loop ----

  private async pollLoop() {
    while (!this.stopped) {
      try {
        const updates: TgUpdate[] = await this.api('getUpdates', {
          offset: this.offset,
          timeout: POLL_TIMEOUT_SEC,
          allowed_updates: ['message'],
        });
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          if (u.message) {
            await this.handleMessage(u.message);
          }
        }
      } catch (err: any) {
        if (this.stopped) break;
        logger.warn({ err: err.message }, '[TgBot] poll error; retrying in 5s');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  // ---- Command dispatch ----

  private rateLimit(userId: number): boolean {
    const now = Date.now();
    const entry = this.recentCmdCount.get(userId);
    if (!entry || now - entry.windowStart > 60_000) {
      this.recentCmdCount.set(userId, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    if (entry.count > 20) return false; // 20 commands per minute max
    return true;
  }

  private async handleMessage(msg: TgMessage) {
    const text = (msg.text || '').trim();
    const userId = msg.from?.id;
    const chatId = msg.chat.id;
    if (!userId || !text) return;

    if (!this.rateLimit(userId)) {
      await this.sendDm(chatId, '_Too many commands. Slow down._');
      return;
    }

    // Parse leading command. Telegram allows `/cmd@botname` form.
    const m = text.match(/^\/([a-zA-Z_]+)(?:@\S+)?(?:\s+(.*))?$/s);
    if (!m) return; // not a command — ignore
    const cmd = m[1].toLowerCase();
    const args = (m[2] || '').trim();

    try {
      switch (cmd) {
        case 'start':  return await this.cmdStart(userId, msg, args);
        case 'wallet': return await this.cmdWallet(userId, chatId, args);
        case 'alerts': return await this.cmdAlerts(userId, chatId, args);
        case 'status': return await this.cmdStatus(userId, chatId);
        case 'ref':    return await this.cmdRef(chatId);
        case 'help':   return await this.cmdHelp(chatId);
        default:
          await this.sendDm(chatId,
            `Unknown command. Try /help.`);
      }
    } catch (err: any) {
      logger.error({ err: err.message, cmd }, '[TgBot] command handler threw');
      await this.sendDm(chatId, `_Internal error handling /${cmd}. Please try again._`);
    }
  }

  // ---- Commands ----

  private async cmdStart(userId: number, msg: TgMessage, args: string) {
    // /start [ref=ABC | refcode]  — capture attribution from links like
    // https://t.me/<bot>?start=campaign1
    const refCode = args ? args.split(/\s+/)[0].slice(0, 64) : null;
    const sub = this.cfg.storage.upsertSubscriber({
      tg_user_id: userId,
      tg_username: msg.from?.username ?? null,
      ref_code: refCode,
    });
    const refNote = refCode ? `\nReferral source: \`${refCode}\` (recorded)` : '';
    const refLinkLine = this.cfg.refLink
      ? `\n\nNew to Offshore? Sign up via my referral: ${this.cfg.refLink}`
      : '';
    await this.sendDm(msg.chat.id,
`*Welcome to Offshore Ops Alerts.*${refNote}

This bot sends you personal alerts about your Offshore Protocol wallet:
  • 🎯 Corp ready to claim — pending +$DIRTY
  • 💸 Corp got liquidated — partial reward arrived
  • ⚠️ INF balance low — top up before ops pause
  • 🔄 Auto-trade disabled — re-enable

Plus market alerts (danger band warnings, calm-window opportunities, cycle events).

To start receiving alerts, register your wallet:
\`/wallet 0x123…\`

*Commands:*
/wallet \\<addr\\> — bind your wallet
/wallet remove — unbind
/alerts on|off — global alert toggle
/status — your current state
/ref — referral link
/help — this list${refLinkLine}`);
    logger.info({ userId, refCode, subId: sub.id }, '[TgBot] /start');
  }

  private async cmdWallet(userId: number, chatId: number, args: string) {
    const sub = this.cfg.storage.upsertSubscriber({ tg_user_id: userId });
    if (!args) {
      const current = sub.wallet_address ?? '_(not set)_';
      await this.sendDm(chatId,
`Your wallet: \`${current}\`

Set: \`/wallet 0x123…\`
Remove: \`/wallet remove\``);
      return;
    }
    if (args.toLowerCase() === 'remove' || args.toLowerCase() === 'clear') {
      this.cfg.storage.setSubscriberWallet(userId, null);
      await this.sendDm(chatId, '_Wallet unbound. Personal alerts paused._');
      return;
    }
    const candidate = args.trim();
    if (!ADDR_RE.test(candidate)) {
      await this.sendDm(chatId,
`That doesn't look like a valid 0x… address.

Example: \`/wallet 0x30C620cf1fbC38083FfE2c645Fb45d7FE487e194\``);
      return;
    }
    this.cfg.storage.setSubscriberWallet(userId, candidate);
    await this.sendDm(chatId,
`✓ Wallet bound: \`${candidate}\`

Personal alerts will start firing within ~30 seconds.
Send /status to see your current corp state.`);
    logger.info({ userId, wallet: candidate.slice(0, 10) }, '[TgBot] wallet bound');
  }

  private async cmdAlerts(userId: number, chatId: number, args: string) {
    this.cfg.storage.upsertSubscriber({ tg_user_id: userId });
    const a = args.toLowerCase();
    if (a === 'on') {
      this.cfg.storage.setSubscriberAlerts(userId, true);
      await this.sendDm(chatId, '_Alerts enabled._');
    } else if (a === 'off') {
      this.cfg.storage.setSubscriberAlerts(userId, false);
      await this.sendDm(chatId, '_Alerts disabled. Re-enable with /alerts on._');
    } else {
      const sub = this.cfg.storage.getSubscriber(userId);
      const state = sub?.alerts_enabled ? 'ON' : 'OFF';
      await this.sendDm(chatId,
`Alerts are *${state}*.
Toggle: \`/alerts on\` or \`/alerts off\``);
    }
  }

  private async cmdStatus(userId: number, chatId: number) {
    const sub = this.cfg.storage.getSubscriber(userId);
    if (!sub) {
      await this.sendDm(chatId, 'No record found. Send /start first.');
      return;
    }
    const wallet = sub.wallet_address ?? '_(not set)_';
    const alerts = sub.alerts_enabled ? 'ON' : 'OFF';
    const since = new Date(sub.created_at).toISOString().replace('T', ' ').slice(0, 16);
    await this.sendDm(chatId,
`*Your subscription:*
Wallet: \`${wallet}\`
Alerts: ${alerts}
Subscribed since: ${since} UTC

Toggle alerts: \`/alerts on|off\`
Change wallet: \`/wallet 0x…\` or \`/wallet remove\``);
  }

  private async cmdRef(chatId: number) {
    if (!this.cfg.refLink) {
      await this.sendDm(chatId, '_(Referral link not configured yet.)_');
      return;
    }
    await this.sendDm(chatId,
`Sign up for Offshore Protocol via my referral:
${this.cfg.refLink}

Both of us get a bonus when you join.`);
  }

  private async cmdHelp(chatId: number) {
    const dashboard = this.cfg.dashboardUrl ? `\n\nLive market dashboard: ${this.cfg.dashboardUrl}` : '';
    await this.sendDm(chatId,
`*Offshore Ops Alerts — commands:*

/start — register / show welcome
/wallet 0x… — bind wallet for personal alerts
/wallet remove — unbind
/alerts on|off — toggle alerts globally
/status — current subscription state
/ref — operator's referral link
/help — this list${dashboard}`);
  }
}
