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
import { config as appConfig } from '../config';
import type { Storage } from '../storage/db';
// Type-only import — avoids a runtime circular dep with corp-bot.ts.
import type { CorpBot } from './corp-bot';

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

interface TgCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  message?: TgMessage;
  data?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** A single inline-keyboard button. */
interface IKBtn { text: string; data: string; }

export interface TgBotConfig {
  token: string;                  // TELEGRAM_BOT_TOKEN
  storage: Storage;
  // Operator's referral link (URL or game-internal code) shown via /ref
  refLink?: string;
  // Optional operator ID to receive admin-style messages (e.g. new subscriber pings).
  // Also gates the /bot admin command — only this user ID can control the trading bot.
  operatorChatId?: number | null;
  // Where the dashboard lives — surfaced via /help
  dashboardUrl?: string;
  // Optional reference to the CorpBot for the /bot admin command. Wired
  // optionally so the TG bot still works even when CorpBot is disabled
  // (e.g. PUBLIC_MODE deployments without a signing key).
  corpBot?: CorpBot | null;
  // Optional read-only state getter — used by /bot burn-money to surface
  // live OpParamsFeed thresholds in the confirmation prompt. Can be
  // omitted; subcommand falls back to "unknown".
  getState?: () => any;
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

  /** Attach the CorpBot reference after construction (CorpBot is built later). */
  attachCorpBot(corpBot: CorpBot) {
    this.cfg.corpBot = corpBot;
  }

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

  /**
   * Send a threshold-cliff alert to the operator with inline action buttons.
   * Two buttons:
   *   - ⏸ Pause Bot     → corpBot.pause() (stops new bootstraps until /bot resume)
   *   - ✕ Dismiss       → just removes the keyboard from the message
   *
   * Cooldown handled upstream in OpParamsFeed.checkThresholdDropAlert
   * (no spam — 60min between alerts per mode).
   */
  async sendThresholdCliffAlert(chatId: number, text: string): Promise<void> {
    if (!this.alive) return;
    const rows: IKBtn[][] = [[
      { text: '⏸ Pause Bot',  data: 'cliff:pause' },
      { text: '✕ Dismiss',    data: 'cliff:dismiss' },
    ]];
    await this.sendDmKb(chatId, text, rows);
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

  /**
   * Public helper: broadcast to a channel.
   * Accepts either a public username (`offshorecasinochannel` or
   * `@offshorecasinochannel`) OR a numeric chat_id as a string
   * (e.g. `-1001234567890` for private channels).
   */
  async sendChannel(channelIdent: string, text: string, opts: { parseMode?: 'Markdown' | 'HTML' } = {}): Promise<void> {
    if (!this.alive) return;
    // Detect numeric chat_id (private channels — usernames don't resolve).
    // Telegram channel IDs are negative integers (typically -100xxxxxxxxxx).
    const isNumeric = /^-?\d+$/.test(channelIdent);
    const chat_id = isNumeric
      ? Number(channelIdent)
      : (channelIdent.startsWith('@') ? channelIdent : '@' + channelIdent);
    try {
      await this.api('sendMessage', {
        chat_id,
        text,
        parse_mode: opts.parseMode ?? 'Markdown',
        disable_web_page_preview: true,
      });
    } catch (err: any) {
      logger.warn({ err: err.message, channelIdent }, '[TgBot] sendChannel failed');
    }
  }

  // ---- Long-poll loop ----

  private async pollLoop() {
    while (!this.stopped) {
      try {
        const updates: TgUpdate[] = await this.api('getUpdates', {
          offset: this.offset,
          timeout: POLL_TIMEOUT_SEC,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          if (u.message) {
            await this.handleMessage(u.message);
          } else if (u.callback_query) {
            await this.handleCallback(u.callback_query);
          }
        }
      } catch (err: any) {
        if (this.stopped) break;
        logger.warn({ err: err.message }, '[TgBot] poll error; retrying in 5s');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  /** Build inline keyboard markup from a 2D button grid. */
  private kb(rows: IKBtn[][]): any {
    return {
      inline_keyboard: rows.map(row =>
        row.map(b => ({ text: b.text, callback_data: b.data })),
      ),
    };
  }

  /** Send a DM with attached inline keyboard. */
  private async sendDmKb(chatId: number, text: string, rows: IKBtn[][]): Promise<void> {
    if (!this.alive) return;
    try {
      await this.api('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: this.kb(rows),
      });
    } catch (err: any) {
      logger.warn({ err: err.message, chatId }, '[TgBot] sendDmKb failed');
    }
  }

  /** Edit a message in place — used to navigate the menu. */
  private async editKb(
    chatId: number, messageId: number, text: string, rows: IKBtn[][],
  ): Promise<void> {
    try {
      await this.api('editMessageText', {
        chat_id:  chatId,
        message_id: messageId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: this.kb(rows),
      });
    } catch (err: any) {
      // Telegram throws if the new content is identical — ignore silently
      if (!String(err.message).includes('not modified')) {
        logger.warn({ err: err.message }, '[TgBot] editKb failed');
      }
    }
  }

  /** ACK a callback_query so Telegram stops the spinner. Optionally show a toast. */
  private async ackCallback(id: string, text?: string): Promise<void> {
    try {
      await this.api('answerCallbackQuery', { callback_query_id: id, text });
    } catch { /* best-effort */ }
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
        case 'bot':
          // Operator-only — if no args, open the GUI menu instead of text status
          if (this.cfg.operatorChatId && userId === this.cfg.operatorChatId && !args) {
            return await this.sendMainMenu(chatId);
          }
          return await this.cmdBot(userId, chatId, args);
        case 'menu':
          // Alias for /bot with no args — explicit GUI entry point
          if (this.cfg.operatorChatId && userId === this.cfg.operatorChatId) {
            return await this.sendMainMenu(chatId);
          }
          await this.sendDm(chatId, 'Unknown command. Try /help.');
          return;
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

  // ============================================================
  // /bot — operator-only admin commands for the trading bot.
  // Auth: only the user ID matching cfg.operatorChatId can run these.
  // Subcommands:  status (default) | pause | resume | drug | arms | ext
  //               claim | thresholds H L | logs | help
  // ============================================================
  private async cmdBot(userId: number, chatId: number, args: string) {
    // Operator-only gate. We compare against the same operatorChatId used for
    // notifications, validated as a strict integer in config.ts.
    if (!this.cfg.operatorChatId || userId !== this.cfg.operatorChatId) {
      // Silent rejection — don't leak the existence of admin commands.
      await this.sendDm(chatId, 'Unknown command. Try /help.');
      return;
    }

    const corpBot = this.cfg.corpBot;
    if (!corpBot) {
      await this.sendDm(chatId, '_Trading bot is not running on this deployment._');
      return;
    }

    const parts = args.split(/\s+/).filter(Boolean);
    const sub   = (parts[0] || 'status').toLowerCase();

    try {
      switch (sub) {
        case 'status': {
          const s = corpBot.getStatus();
          const corps = s.perCorp.length === 0
            ? '  _(no corp data yet — wait for first tick)_'
            : s.perCorp.map(c =>
                `  \`${c.addr.slice(0, 10)}..\` ${c.auto ? '✅' : '❌'} ${c.modeName}`
              ).join('\n');

          // Balances block — only render when the OnchainBalancesFeed has data.
          // Per-hour rates only show after the 60s baseline is established.
          const fmt = (n: number, dec = 2) => n.toLocaleString('en-US', {
            minimumFractionDigits: dec, maximumFractionDigits: dec,
          });
          const rate = (r: number | null, suffix: string) =>
            r === null ? '' : ` _(${r >= 0 ? '+' : ''}${fmt(r, 1)}${suffix})_`;

          const balancesBlock = s.balances ? `
*Wallet:*
  INF:    \`${fmt(s.balances.inf)}\`${rate(s.balances.infPerHr,   '/hr')}
  DIRTY:  \`${fmt(s.balances.dirty)}\`${rate(s.balances.dirtyPerHr, '/hr')}
  USDM:   \`${fmt(s.balances.usdm)}\`${rate(s.balances.usdmPerHr,  '/hr')}
` : '\n_(wallet balances unavailable — feed warming up)_\n';

          // Live INF cost per op (post-DIRTY-price-adjusted). Single global
          // value across all modes per chain sampling 2026-05-09. Pulled from
          // OpParamsFeed via the engine state getter.
          const opParams = (this.cfg.getState?.() as any)?.opParams;
          const infCostBlock = opParams?.infCostPerOp
            ? `*INF cost/op:* \`${opParams.infCostPerOp.toFixed(2)}\` _(network-median, n=${opParams.infCostSampleCount ?? 0})_\n`
            : '';

          // Locked corps + operator-override grace state. Operator-only
          // controls — surface so the operator can see what's currently
          // outside the bot's reach.
          const locked = corpBot.getLockedCorps();
          const overrides = corpBot.getOperatorOverrides();
          let lockBlock = '';
          if (locked.length > 0) {
            const labels = locked.map(addr => {
              const idx = s.perCorp.findIndex(c => c.addr.toLowerCase() === addr) + 1;
              return idx > 0 ? '#' + idx : addr.slice(0, 8);
            }).join(', ');
            lockBlock += `*Locked corps:* 🔒 ${labels}\n`;
          }
          if (overrides.length > 0) {
            const lines = overrides.map(o => {
              const idx = s.perCorp.findIndex(c => c.addr.toLowerCase() === o.corp) + 1;
              const m = Math.ceil(o.remainingMs / 60_000);
              return `  ${idx > 0 ? '#' + idx : o.corp.slice(0,8)} (${m}m remaining)`;
            }).join('\n');
            lockBlock += `*Operator grace:* ✋\n${lines}\n`;
          }

          // SafetyGate state — shadow vs live, current per-op safety scores,
          // 24h decision rollup. The gate is shadow-by-default until we
          // have ~5-7 days of decisions to validate against op_outcomes.
          const scores = (this.cfg.getState?.() as any)?.scores;
          let gateBlock = '';
          try {
            const config = require('../config').config;
            if (!config.safetyGateDisabled) {
              const sinceMs = Date.now() - 24 * 3600_000;
              const rollup = this.cfg.storage?.getSafetyGateRollup(sinceMs) ?? [];
              const allow = rollup.find(r => r.decision === 'allow')?.n ?? 0;
              const block = rollup.find(r => r.decision === 'block')?.n ?? 0;
              const mode = config.safetyGateShadow ? 'SHADOW' : 'LIVE';
              const tDrug = config.safetyGateDrugThreshold;
              const tArms = config.safetyGateArmsThreshold;
              const tExt  = config.safetyGateExtThreshold;
              const fmtScore = (n: number | null | undefined) => n == null ? '—' : n.toFixed(0);
              gateBlock =
                `*SafetyGate:* \`${mode}\` · live scores ` +
                `Ext=${fmtScore(scores?.extortion)} ` +
                `Arms=${fmtScore(scores?.arms)} ` +
                `Drug=${fmtScore(scores?.drug)}\n` +
                `   thresholds: Drug≥${tDrug || 'OFF'} · Arms≥${tArms || 'OFF'} · Ext≥${tExt || 'OFF'}\n` +
                `   24h decisions: ${allow} allow · ${block} would-block\n`;
            }
          } catch { /* status renders without gate block on error */ }

          // Format target modes per corp
          const targetStr = s.targetModes.map((m, i) =>
            `corp${i+1}=${['Ext','Arms','Drug'][m] ?? m}`
          ).join(', ');

          // Schedule line — also explain the FALLBACK so the operator
          // understands what happens when both schedule + manual are off.
          const scheduleLine = s.scheduleEnabled
            ? `Schedule: ON · ${s.hktHour.toString().padStart(2,'0')}h HKT → \`${s.schedulePresetThisHour}\``
            : `Schedule: OFF — fallback is *paused* (use \`/bot on\` to resume)`;
          // Decode the activePresetName label into a readable "why":
          //   manual:X            → "manual override → X"
          //   auto:X              → "schedule slot → X"
          //   breaker:paused      → "circuit breaker tripped"
          //   danger:panic        → "danger override active"
          //   fallback:X          → "fallback (no schedule, no manual) → X"
          const presetSourceExplain = (label: string) => {
            if (label.startsWith('manual:'))     return '🔒 manual lock';
            if (label.startsWith('auto:'))       return '📅 schedule';
            if (label.startsWith('breaker:'))    return '🚨 circuit breaker';
            if (label.startsWith('danger:'))     return '⚠ danger override';
            if (label.startsWith('fallback:'))   return '⤵ fallback';
            return '?';
          };
          const sourceTag = presetSourceExplain(s.activePresetName);

          // Circuit breaker line — only show when notable (tripped or pressure building)
          const cb = s.circuitBreaker;
          let breakerLine = '';
          if (cb.tripped) {
            const m = Math.floor(cb.cooldownSecondsRemaining / 60);
            breakerLine = `\n🚨 *Breaker TRIPPED* — clears in ${m}m ${cb.cooldownSecondsRemaining % 60}s`;
          } else if (cb.recentLiquidationCount > 0) {
            breakerLine = `\nBreaker pressure: ${cb.recentLiquidationCount}/${cb.threshold} corps liquidated in last ${(cb.windowSeconds/60).toFixed(0)}m`;
          }

          await this.sendDm(chatId,
`*🤖 Corp Bot Status*

State: ${s.running ? (s.paused ? '⏸ *PAUSED*' : '▶️ Running') : '⛔ Stopped'}
Signer: \`${s.signer ?? '(none)'}\`
Owns:   ${s.ownedCorps}/${s.totalCorps} corps

*Active preset:* \`${s.activePresetName}\`
   *Source:* ${sourceTag}
Targets: ${targetStr}
${scheduleLine}
Last danger: ${s.lastDanger ?? '_n/a_'} (panic at ≥${s.panicThreshold})${breakerLine}
${lockBlock}${infCostBlock}${gateBlock}${balancesBlock}
*Per-corp on-chain:*
${corps}

Subcommands: \`/bot help\``);
          return;
        }

        case 'help': {
          await this.sendDm(chatId,
`*🤖 Corp Bot — admin commands*

*State:*
\`/bot\` — current state
\`/bot logs\` — last 20 CorpBot log lines
\`/bot claim\` — claim pending rewards on all corps now
\`/bot eff [hours]\` — on-demand INF efficiency DM (default 24h)
\`/bot quiet on|off|status\` — mute low-signal DMs (claims, mode-switches, etc) keeping only critical alerts + daily digest

*Stop / start (most common):*
\`/bot off\` — *full stop* (locks paused preset, calls disableAutoTrade on every corp)
\`/bot on\`  — release lock, resume schedule
\`/bot pause\` / \`/bot resume\` — soft pause (stops bot writes; on-chain auto-trade keeps running)

*Per-corp manual control:*
\`/bot lockcorp <index>\` — exclude a corp from automation entirely (persists across restarts)
\`/bot lockcorp list\` — show currently locked corps
\`/bot unlockcorp <index>\` — re-include a corp
   ↳ Tip: if you disable auto-trade on a corp via the in-game UI, the bot
   gives you ${appConfig.botOperatorGraceMin}min grace before re-enabling. For permanent control, use lockcorp.

*Presets (loadouts):*
\`/bot preset list\` — list all presets
\`/bot preset <name>\` — manually lock to a preset (e.g. \`mix-arms\`)
\`/bot preset auto\` — release lock, follow schedule
\`/bot custom <m1> ... <mN>\` — quick custom, one mode per corp (1=Arms 2=Drug, no Ext)
\`/bot drug\` / \`/bot arms\` — force uniform mode

*Schedule (HKT-based):*
\`/bot schedule\` — show 24h schedule
\`/bot schedule on|off\` — toggle scheduling
   ↳ when OFF: bot stops trading (paused fallback). Use \`/bot drug\` etc. to manually run.
\`/bot schedule <hour|range> <preset>\` — e.g. \`/bot schedule 21-22 paused\`

*Thresholds:*
\`/bot thresholds <high> <low>\` — danger band (default 65/45)
\`/bot panic <threshold>\` — danger override threshold (default 75)

*Circuit breaker (reactive INF protection):*
\`/bot breaker\` — show state and pressure
\`/bot breaker clear\` — pop the breaker manually
\`/bot breaker config <window_min> <threshold> <cooldown_min>\` — tune

*Pause:*
\`/bot pause\` — operator pause (no writes at all)
\`/bot resume\` — re-enable

Built-in presets:
• \`all-arms\` — 3 Arms (calm hours, 30m cycles, 0.176% liq threshold)
• \`all-drug\` — 3 Drug (active hours, 90m cycles, 0.518% liq threshold)
• \`mix-arms\` — 2 Arms + 1 Drug (hedged calm)
• \`mix-drug\` — 2 Drug + 1 Arms (hedged active)
• \`paused\` / \`panic\` — disable auto-trade (saves INF in dead zones)

*🧬 COPY-MODE (mirror top whales):*
\`/bot copy on\` — mirror the top 5 wallets by 72h SR (≥75% SR, ≥50 ops)
\`/bot copy off\` — release back to schedule
\`/bot copy status\` — pool mean SR + our recent copy SR
   ↳ Auto-disables if our last-20 copy SR drops below network rolling SR.

*🔥 BURN-MONEY (high-risk, operator-confirmed only):*
\`/bot burn-money\` — show confirmation prompt with live threshold
\`/bot burn-money confirm\` — engage all-Extortion for 30 min, then auto-revert

Op thresholds + leverage are live-sampled from chain (devs recalibrate every ~48h plus weekend mode Fri-Sun HKT). The \`/bot burn-money\` prompt always shows the current live values.`);
          return;
        }

        case 'pause': {
          corpBot.pause();
          await this.sendDm(chatId,
            '⏸ *Bot paused.* My interventions stop, BUT auto-trade keeps running on-chain ' +
            'if it was already enabled — the corps will continue ops on their own.\n\n' +
            'For a *full stop* (disables auto-trade on every corp), use `/bot off` instead.\n' +
            'Resume with `/bot resume`.');
          return;
        }

        // /bot off — full stop. Sets the manual preset to `paused` which
        // makes the bot call disableAutoTrade() on every corp on the next
        // tick. This is the unambiguous "stop trading" command.
        case 'off':
        case 'stop': {
          const r = corpBot.setManualPreset('paused');
          if (r.ok) {
            await this.sendDm(chatId,
              `🛑 *Bot OFF.* Manual preset locked to *paused*.\n\n` +
              `Bot will call \`disableAutoTrade()\` on every corp on the next tick. ` +
              `No new ops will start until you re-enable.\n\n` +
              `*To resume:*\n` +
              `\`/bot on\`             — release lock, follow schedule\n` +
              `\`/bot drug\` / \`/bot arms\` — manual mode\n` +
              `\`/bot preset <name>\`  — specific preset`,
            );
          } else {
            await this.sendDm(chatId, `Failed: ${r.reason}`);
          }
          return;
        }

        // /bot on — release manual lock, resume schedule.
        case 'on': {
          const r = corpBot.setManualPreset(null);
          if (r.ok) {
            const s = corpBot.getStatus();
            const slot = s.scheduleEnabled ? s.schedulePresetThisHour : '(schedule disabled)';
            await this.sendDm(chatId,
              `▶️ *Bot ON.* Manual lock cleared.\n\n` +
              (s.scheduleEnabled
                ? `Now following the schedule — current HKT slot is *${slot}*.`
                : `⚠ Schedule is currently *OFF* — bot will be paused via fallback.\n` +
                  `Run \`/bot schedule on\` to follow the time-of-day schedule.`),
            );
          } else {
            await this.sendDm(chatId, `Failed: ${r.reason}`);
          }
          return;
        }

        // /bot lockcorp <index|addr> — permanently exclude a corp from
        // bot automation. Persisted across restarts. Operator gets full
        // manual control of that corp (no claim, no mode switch, no
        // re-enable). Use /bot unlockcorp to re-include.
        case 'lockcorp':
        case 'lock': {
          const arg = parts[1];
          if (!arg || arg.toLowerCase() === 'list') {
            const locked = corpBot.getLockedCorps();
            const status = corpBot.getStatus();
            const lines = locked.length === 0
              ? '_(none)_'
              : locked.map(addr => {
                  const idx = status.perCorp.findIndex(c => c.addr.toLowerCase() === addr) + 1;
                  return `  ${idx > 0 ? '#' + idx : '?'} \`${addr.slice(0, 10)}..\``;
                }).join('\n');
            await this.sendDm(chatId,
              `🔒 *Locked corps* (${locked.length}/${status.totalCorps})\n\n${lines}\n\n` +
              `Use \`/bot lockcorp <index>\` to add (1-${status.totalCorps})\n` +
              `Use \`/bot unlockcorp <index>\` to remove`);
            return;
          }
          const r = corpBot.lockCorp(arg);
          if (r.ok) {
            const status = corpBot.getStatus();
            const idx = status.perCorp.findIndex(c => c.addr.toLowerCase() === r.corp) + 1;
            await this.sendDm(chatId,
              `🔒 *Corp locked*\n` +
              `Corp ${idx > 0 ? '#' + idx : ''} \`${r.corp!.slice(0,10)}..\` is now under your full manual control.\n\n` +
              `The bot will:\n` +
              `• NOT call enableAutoTrade / disableAutoTrade\n` +
              `• NOT switch modes\n` +
              `• NOT auto-claim rewards\n` +
              `• NOT bootstrap startTrade\n\n` +
              `Run \`/bot unlockcorp ${idx > 0 ? idx : r.corp}\` to release.`,
            );
          } else {
            await this.sendDm(chatId, `❌ Lock failed: ${r.reason}`);
          }
          return;
        }

        case 'unlockcorp':
        case 'unlock': {
          const arg = parts[1];
          if (!arg) {
            await this.sendDm(chatId, 'Usage: `/bot unlockcorp <index|address>`');
            return;
          }
          const r = corpBot.unlockCorp(arg);
          if (r.ok) {
            await this.sendDm(chatId,
              `🔓 *Corp unlocked*\n` +
              `\`${r.corp!.slice(0,10)}..\` will resume bot automation on the next tick.`);
          } else {
            await this.sendDm(chatId, `❌ Unlock failed: ${r.reason}`);
          }
          return;
        }

        case 'resume': {
          corpBot.resume();
          await this.sendDm(chatId, '▶️ *Bot resumed.* Will tick now and react to danger score.');
          return;
        }

        case 'drug':
        case 'arms': {
          const mode = sub === 'drug' ? 2 : 1;
          const name = sub === 'drug' ? 'Drug' : 'Arms';
          const res  = corpBot.forceMode(mode);
          if (!res.ok) {
            await this.sendDm(chatId, `❌ ${res.reason}`);
          } else {
            await this.sendDm(chatId,
              `🎯 *Force mode → ${name}*\n` +
              `Cooldowns cleared. All ${corpBot.getStatus().totalCorps} corps will switch on the next tick (~30s).`);
          }
          return;
        }

        case 'ext':
        case 'extortion': {
          // Old guard preserved — `/bot ext` directly is still rejected
          // because it bypasses the two-step confirmation. Use the
          // dedicated /bot burn-money command if you really mean it.
          await this.sendDm(chatId,
            `❌ *Direct Extortion shortcut disabled.*\n\n` +
            `Extortion is high-risk and requires explicit confirmation.\n` +
            `Use \`/bot burn-money\` instead — that command shows the\n` +
            `current threshold + leverage and requires a confirm step.`);
          return;
        }

        case 'burn-money':
        case 'burn_money':
        case 'burn': {
          // Two-step confirmation. Step 1 (no extra arg): show current
          // Ext threshold + leverage from live OpParamsFeed, ask for
          // explicit /bot burn-money confirm. Step 2: engage the preset
          // for BURN_MONEY_MAX_DURATION_MS, auto-revert after.
          const isConfirm = (parts[1] || '').toLowerCase() === 'confirm';
          // Pull live op params for the warning text
          const op = (this.cfg.getState?.() as any)?.opParams;
          const extThresh = op?.thresholds?.[0];
          const isWeekend = !!op?.isWeekend;
          const threshStr = Number.isFinite(extThresh)
            ? (extThresh * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '%'
            : 'unknown (feed warming up)';
          const leverageStr = Number.isFinite(extThresh) && extThresh > 0
            ? Math.round(1 / extThresh).toLocaleString() + '×'
            : 'unknown';

          if (!isConfirm) {
            const status = corpBot.getStatus();
            const currentPreset = status.activePresetName;
            // Live INF cost per op for accurate burn-rate projection
            const infCost = op?.infCostPerOp ?? null;
            const infCostStr = infCost ? `~${infCost.toFixed(2)} INF` : '~5 INF (estimate)';
            // Worst-case: every op fails, all N corps burn the cost every 5min
            // → N × 12 ops/hr × infCost. Network ~80%+ failure makes this realistic.
            const projHrBurn = infCost
              ? (status.totalCorps * 12 * infCost).toFixed(0)
              : '~360';
            await this.sendDm(chatId,
              `🔥 *BURN-MONEY CONFIRMATION*\n\n` +
              `You're about to switch *all ${status.totalCorps} corps* to *Extortion*.\n\n` +
              `*Live params* ${isWeekend ? '_(WEEKEND mode)_' : ''}\n` +
              `  Window:    5 min\n` +
              `  Threshold: \`${threshStr}\`\n` +
              `  Leverage:  \`${leverageStr}\`\n` +
              `  INF/op:    \`${infCostStr}\`\n\n` +
              `Network avg P(fail) for Extortion right now is ~80%+. ` +
              `Worst-case burn at ${status.totalCorps} corps × 12 cycles/hr × ${infCostStr}: ` +
              `*~${projHrBurn} INF/hr*.\n\n` +
              `*Auto-reverts* to \`${currentPreset}\` after 30 minutes.\n\n` +
              `Reply \`/bot burn-money confirm\` to engage.\n` +
              `Reply anything else to abort.`,
            );
            return;
          }

          // Step 2 — engage
          const result = corpBot.enableBurnMoney();
          const minsLeft = Math.round((result.revertsAt - Date.now()) / 60_000);
          const revertLabel = result.revertsTo ?? 'auto schedule';
          await this.sendDm(chatId,
            `🔥 *BURN-MONEY ENGAGED*\n\n` +
            `All corps switching to *Extortion*. Mode change tx in flight.\n` +
            `Window: 5 min · Threshold: \`${threshStr}\` · Leverage: \`${leverageStr}\`\n\n` +
            `*Auto-reverts* in ~${minsLeft} min to \`${revertLabel}\`.\n` +
            `Issue \`/bot preset auto\` (or any other preset) to cancel early.`,
          );
          return;
        }

        case 'copy': {
          // /bot copy on    → enable copy-mode (whale top-5 by 72h SR)
          // /bot copy off   → disable, revert to schedule
          // /bot copy status (default) → show pool + recent SR
          const action = (parts[1] || 'status').toLowerCase();
          if (action === 'on' || action === 'enable') {
            const r = corpBot.enableCopyMode();
            if (!r.ok) {
              await this.sendDm(chatId, `❌ *Copy-mode failed*\n\n${r.reason}`);
              return;
            }
            await this.sendDm(chatId,
              `🧬 *COPY-MODE ENABLED*\n\n` +
              `Now mirroring the top 5 whales by 72h SR (min 50 ops, ≥75% SR).\n` +
              `Pool mean SR: *${((r.poolMeanSr ?? 0) * 100).toFixed(1)}%*\n\n` +
              `Bot will fire one of YOUR free corps in the same op-mode whenever ` +
              `a pool whale starts a new trade.\n\n` +
              `*Auto-disable* if our last-20 copy SR drops below network SR.\n` +
              `Run \`/bot copy off\` or \`/bot preset auto\` to release.`,
            );
            return;
          }
          if (action === 'off' || action === 'disable' || action === 'stop') {
            corpBot.disableCopyMode('operator');
            await this.sendDm(chatId,
              `🛑 *Copy-mode disabled.*\n` +
              `Reverting to auto schedule on next tick.`);
            return;
          }
          // status (default)
          const cs = corpBot.getCopyState();
          const recent = cs.recent;
          const srLine = recent && recent.resolved > 0
            ? `Our last-${recent.resolved} copies: *${((recent.sr ?? 0) * 100).toFixed(1)}%* (${recent.wins}/${recent.resolved})`
            : `Our copies: _no resolved samples yet_`;
          const firedLine = recent
            ? `Fired total (last 20): ${recent.fired}, resolved: ${recent.resolved}`
            : '';
          await this.sendDm(chatId,
            `🧬 *Copy-mode status*\n\n` +
            `State: ${cs.enabled ? '*ENABLED*' : 'disabled'}\n` +
            `Pool mean SR: *${(cs.poolMeanSr * 100).toFixed(1)}%*\n` +
            srLine + (firedLine ? `\n${firedLine}` : '') + `\n\n` +
            `Toggle: \`/bot copy on\` | \`/bot copy off\``,
          );
          return;
        }

        case 'claim': {
          await this.sendDm(chatId, '_Claiming on all corps with pending rewards..._');
          const results = await corpBot.forceClaim();
          const lines = results.map(r => {
            const label = `\`${r.corp.slice(0, 10)}..\``;
            if (r.tx)        return `${label} ✅ ${(r.reward ?? 0).toFixed(2)} DIRTY`;
            if (r.error)     return `${label} ⚠️ ${r.error}`;
            return `${label} (no result)`;
          }).join('\n');
          await this.sendDm(chatId,
            `*Claim results:*\n${lines}`);
          return;
        }

        case 'thresholds': {
          const high = parseInt(parts[1] ?? '');
          const low  = parseInt(parts[2] ?? '');
          if (!Number.isFinite(high) || !Number.isFinite(low)) {
            await this.sendDm(chatId,
              'Usage: `/bot thresholds <high> <low>`\nExample: `/bot thresholds 70 40`');
            return;
          }
          const res = corpBot.setThresholds(high, low);
          if (!res.ok) {
            await this.sendDm(chatId, `❌ ${res.reason}`);
          } else {
            await this.sendDm(chatId,
              `✅ *Thresholds updated.*\nHIGH = ${high}, LOW = ${low}\n` +
              `Bot will switch to Arms when danger ≥${high}, back to Drug when ≤${low}.`);
          }
          return;
        }

        case 'logs': {
          const s = corpBot.getStatus();
          const recent = s.recentLogs.slice(-20);
          if (recent.length === 0) {
            await this.sendDm(chatId, '_(no recent log entries)_');
            return;
          }
          const body = recent.map(l => l.length > 120 ? l.slice(0, 117) + '...' : l).join('\n');
          await this.sendDm(chatId, '```\n' + body + '\n```', { parseMode: 'Markdown' });
          return;
        }

        case 'preset': {
          const action = (parts[1] || 'show').toLowerCase();

          if (action === 'list') {
            const presets = corpBot.listPresets();
            const lines = presets.map(p => {
              const tag = p.paused ? '⏸ paused' : p.modes.map(m => ['Ext','Arms','Drug'][m]).join('/');
              return `  • \`${p.name}\` — ${tag}`;
            }).join('\n');
            await this.sendDm(chatId, `*Available presets:*\n${lines}\n\nApply with \`/bot preset <name>\`.`);
            return;
          }

          if (action === 'show' || !action) {
            const s = corpBot.getStatus();
            await this.sendDm(chatId,
              `Active preset: \`${s.activePresetName}\` (${s.scheduleMode})\n` +
              `Targets: ${s.targetModes.map((m,i) => `corp${i+1}=${['Ext','Arms','Drug'][m]}`).join(', ')}`);
            return;
          }

          // Otherwise treat as preset name (or 'auto' to release lock)
          const res = corpBot.setManualPreset(action);
          if (!res.ok) {
            await this.sendDm(chatId, `❌ ${res.reason}`);
          } else if (action === 'auto') {
            await this.sendDm(chatId, `▶️ Released manual lock. Bot following HKT schedule.`);
          } else {
            await this.sendDm(chatId, `🎯 *Preset locked: \`${action}\`*\nWill apply on next tick (~30s). Release with \`/bot preset auto\`.`);
          }
          return;
        }

        case 'custom': {
          // Parse N mode integers — one per active corp. Only 1 (Arms) or 2 (Drug) allowed.
          const expected = corpBot.getStatus().totalCorps;
          const modes = parts.slice(1).map(p => parseInt(p));
          if (modes.length !== expected || modes.some(m => m !== 1 && m !== 2)) {
            const placeholders = Array.from({ length: expected }, (_, i) => `<m${i + 1}>`).join(' ');
            const example = Array.from({ length: expected }, (_, i) => (i < Math.ceil(expected * 2 / 3) ? '1' : '2')).join(' ');
            const armsCount = expected - Math.floor(expected / 3);
            const drugCount = expected - armsCount;
            await this.sendDm(chatId,
              `Usage: \`/bot custom ${placeholders}\` (${expected} corps active)\n` +
              '(1=Arms 2=Drug — Extortion disabled)\n' +
              `Example: \`/bot custom ${example}\` (${armsCount} Arms + ${drugCount} Drug)`);
            return;
          }
          // Save as a custom preset and lock to it
          const def = corpBot.setCustomPreset('custom', modes);
          if (!def.ok) {
            await this.sendDm(chatId, `❌ ${def.reason}`);
            return;
          }
          const lock = corpBot.setManualPreset('custom');
          if (!lock.ok) {
            await this.sendDm(chatId, `❌ ${lock.reason}`);
            return;
          }
          const labels = modes.map(m => ['Ext','Arms','Drug'][m]).join(' / ');
          await this.sendDm(chatId, `🎯 *Custom preset locked: ${labels}*\nRelease with \`/bot preset auto\`.`);
          return;
        }

        case 'schedule': {
          const action = (parts[1] || 'show').toLowerCase();

          if (action === 'show' || !action) {
            const s = corpBot.getStatus();
            const sched = corpBot.getSchedule();
            // Group consecutive identical hours into ranges for compact display
            const ranges: { start: number; end: number; preset: string }[] = [];
            for (let h = 0; h < 24; h++) {
              const last = ranges[ranges.length - 1];
              if (last && last.preset === sched[h] && last.end === h - 1) {
                last.end = h;
              } else {
                ranges.push({ start: h, end: h, preset: sched[h] });
              }
            }
            const lines = ranges.map(r => {
              const range = r.start === r.end
                ? `${r.start.toString().padStart(2,'0')}h     `
                : `${r.start.toString().padStart(2,'0')}h-${r.end.toString().padStart(2,'0')}h`;
              const cur = (r.start <= s.hktHour && s.hktHour <= r.end) ? ' ←' : '';
              return `  ${range}  \`${r.preset}\`${cur}`;
            }).join('\n');
            await this.sendDm(chatId,
              `*HKT Schedule* (${s.scheduleEnabled ? 'ENABLED' : 'DISABLED'}):\n\n${lines}\n\nNow: ${s.hktHour.toString().padStart(2,'0')}h HKT`);
            return;
          }

          if (action === 'on') {
            corpBot.setScheduleEnabled(true);
            await this.sendDm(chatId, `✅ Schedule ENABLED. Bot will follow HKT schedule.`);
            return;
          }
          if (action === 'off') {
            corpBot.setScheduleEnabled(false);
            await this.sendDm(chatId,
              `⏸ Schedule DISABLED. Bot falls back to \`paused\` — auto-trade off on every corp on the next tick.\n\n` +
              `Use \`/bot schedule on\` to resume the HKT schedule, or set a manual preset (\`/bot drug\`, \`/bot arms\`, etc.).`);
            return;
          }

          // Otherwise: /bot schedule <hour|range> <preset>
          // Hour can be "5" or "21-22"
          const hourSpec = parts[1] || '';
          const presetName = parts[2] || '';
          if (!hourSpec || !presetName) {
            await this.sendDm(chatId,
              'Usage: `/bot schedule <hour|range> <preset>`\n' +
              'Examples:\n' +
              '  `/bot schedule 21-22 paused`\n' +
              '  `/bot schedule 5 mix-arms`');
            return;
          }
          const hours: number[] = [];
          const m = hourSpec.match(/^(\d+)(?:-(\d+))?$/);
          if (!m) {
            await this.sendDm(chatId, `❌ Invalid hour spec: \`${hourSpec}\``);
            return;
          }
          const h1 = parseInt(m[1]);
          const h2 = m[2] !== undefined ? parseInt(m[2]) : h1;
          for (let h = h1; h <= h2; h++) hours.push(h);

          const res = corpBot.setScheduleHours(hours, presetName);
          if (!res.ok) {
            await this.sendDm(chatId, `❌ ${res.reason}`);
          } else {
            await this.sendDm(chatId, `✅ Schedule updated: hours \`${hourSpec}\` → \`${presetName}\``);
          }
          return;
        }

        case 'panic': {
          const t = parseInt(parts[1] ?? '');
          if (!Number.isFinite(t)) {
            const s = corpBot.getStatus();
            await this.sendDm(chatId,
              `Panic threshold: ${s.panicThreshold} (forces panic preset when danger ≥ this)\n` +
              `Set: \`/bot panic <0-100>\``);
            return;
          }
          const res = corpBot.setPanicThreshold(t);
          if (!res.ok) {
            await this.sendDm(chatId, `❌ ${res.reason}`);
          } else {
            await this.sendDm(chatId, `✅ Panic threshold = ${t}. Bot will force panic preset when danger ≥${t}.`);
          }
          return;
        }

        case 'breaker': {
          const action = (parts[1] || 'status').toLowerCase();
          const s = corpBot.getStatus();
          const cb = s.circuitBreaker;

          if (action === 'status' || !action) {
            const stateLine = cb.tripped
              ? `🚨 *TRIPPED* — pause clears in ${Math.floor(cb.cooldownSecondsRemaining / 60)}m ${cb.cooldownSecondsRemaining % 60}s`
              : `✅ Armed (no recent breaker events)`;
            await this.sendDm(chatId,
`*🔌 Circuit Breaker*

State: ${stateLine}
Window: distinct corps liquidated in last *${(cb.windowSeconds / 60).toFixed(1)} min*
Threshold: trips at *${cb.threshold}* distinct corps
Current pressure: *${cb.recentLiquidationCount}/${cb.threshold}* corps liquidated in window
Total trips this session: ${cb.totalTrips}

Subcommands:
\`/bot breaker clear\` — pop the breaker manually
\`/bot breaker config <window_min> <threshold> <cooldown_min>\` — tune (e.g. \`/bot breaker config 5 3 30\`)`);
            return;
          }

          if (action === 'clear') {
            const res = corpBot.clearCircuitBreaker();
            if (!res.wasTripped) {
              await this.sendDm(chatId, '_Breaker was not tripped — nothing to clear._');
            } else {
              await this.sendDm(chatId, '✅ Circuit breaker cleared. Bot resumes schedule on next tick.');
            }
            return;
          }

          if (action === 'config') {
            const win  = parseFloat(parts[2] ?? '');
            const thr  = parseInt(parts[3]   ?? '');
            const cool = parseFloat(parts[4] ?? '');
            if (!Number.isFinite(win) || !Number.isFinite(thr) || !Number.isFinite(cool)) {
              await this.sendDm(chatId,
                'Usage: `/bot breaker config <window_min> <threshold> <cooldown_min>`\n' +
                'Example: `/bot breaker config 5 2 30`\n' +
                '(5-min window, trip at 2 corps, pause 30 min)');
              return;
            }
            const res = corpBot.setCircuitBreakerConfig({
              windowMs:   win  * 60_000,
              threshold:  thr,
              cooldownMs: cool * 60_000,
            });
            if (!res.ok) {
              await this.sendDm(chatId, `❌ ${res.reason}`);
            } else {
              await this.sendDm(chatId,
                `✅ Breaker tuned: window=${win}m, threshold=${thr}, cooldown=${cool}m`);
            }
            return;
          }

          await this.sendDm(chatId, `Unknown breaker action: \`${action}\`. Try \`/bot breaker\`.`);
          return;
        }

        case 'quiet': {
          // Toggle low-signal DMs. When ON, only critical alerts pass
          // through (circuit breaker, burn-money expiry, copy auto-
          // disable, operator-grace, threshold-cliff, RedStone divergence,
          // and the daily 09:00 HKT digest). Persisted to corp-bot-state.json.
          const arg = (parts[1] || 'status').toLowerCase();
          if (arg === 'on') {
            corpBot.setQuiet(true);
            await this.sendDm(chatId,
              `🤫 *Quiet mode ON*\n\n` +
              `Per-corp claim / switch / re-enable / trade-start DMs are suppressed.\n` +
              `You'll still receive:\n` +
              `  • Circuit breaker trip/clear\n` +
              `  • Threshold-cliff alerts\n` +
              `  • RedStone divergence alerts\n` +
              `  • Burn-money expiry\n` +
              `  • Copy-mode auto-disable\n` +
              `  • Operator-grace acknowledgment\n` +
              `  • 09:00 HKT efficiency digest\n\n` +
              `Disable: \`/bot quiet off\``);
          } else if (arg === 'off') {
            corpBot.setQuiet(false);
            await this.sendDm(chatId, `🔔 *Quiet mode OFF* — all DMs restored.`);
          } else if (arg === 'status') {
            await this.sendDm(chatId,
              `Quiet mode is currently *${corpBot.isQuiet() ? 'ON 🤫' : 'OFF 🔔'}*.\n` +
              `Toggle: \`/bot quiet on\` or \`/bot quiet off\``);
          } else {
            await this.sendDm(chatId, `Usage: \`/bot quiet on|off|status\``);
          }
          return;
        }

        case 'efficiency':
        case 'eff': {
          // On-demand version of the 09:00 HKT daily DM. Computes the
          // 24h + 7d efficiency snapshots from the live DB and renders
          // through the same composer the scheduler uses, so the
          // operator sees an identical message any time.
          // `hours` arg lets the operator request a different window
          // (e.g. `/bot eff 48` for last 48h). Defaults to 24h.
          const arg = parts[1];
          const hours = arg ? Math.max(1, Math.min(720, parseInt(arg, 10) || 24)) : 24;
          const { computeEfficiency } = await import('./efficiency');
          const { Broadcaster } = await import('./broadcaster');
          const eff = computeEfficiency(this.cfg.storage, { windowHours: hours });
          const eff7d = computeEfficiency(this.cfg.storage, { windowHours: 168 });
          // Claim summary across the same window the caller asked for.
          const claims = corpBot.getClaimSummary(hours);
          // Throwaway broadcaster instance — composer is a pure method
          // that doesn't use the bot/channel fields.
          const tmp = new Broadcaster({ bot: this, channelHandle: '' } as any);
          // Override the headline label when caller asked for non-24h.
          const dm = tmp.composeOperatorEfficiencyDm({ eff24h: eff, eff7d, claims24h: claims });
          const text = hours === 24
            ? dm
            : dm.replace('📊 *24h INF Efficiency*', `📊 *${hours}h INF Efficiency*`);
          await this.sendDm(chatId, text);
          return;
        }

        default:
          await this.sendDm(chatId, `Unknown subcommand: \`${sub}\`. Try \`/bot help\`.`);
      }
    } catch (err: any) {
      logger.error({ err: err.message, sub }, '[TgBot] /bot handler threw');
      await this.sendDm(chatId, `_Error running /bot ${sub}: ${err?.message ?? 'unknown'}_`);
    }
  }

  // ============================================================
  // GUI MENU SYSTEM (inline keyboard)
  //
  // The text/keyboard pair for each menu lives in a `renderMenu*()` helper.
  // Navigation = edit the same message in place via editKb(). callback_data
  // is structured `<screen>:<action>:<arg>` so handleCallback() can route
  // without needing a state map (each click contains all the info we need).
  // ============================================================

  /** Entry point: send the main menu as a fresh message. */
  async sendMainMenu(chatId: number): Promise<void> {
    const { text, rows } = this.renderMainMenu();
    await this.sendDmKb(chatId, text, rows);
  }

  private renderMainMenu(): { text: string; rows: IKBtn[][] } {
    const cb = this.cfg.corpBot;
    if (!cb) {
      return {
        text: '*🤖 Offshore Bot*\n\n_Trading bot disabled (no MAIN_KEY)._',
        rows: [],
      };
    }
    const s = cb.getStatus();
    const stateEmoji = s.running
      ? (s.paused ? '⏸ Paused' : '▶️ Running')
      : '⛔ Stopped';
    const breaker = s.circuitBreaker.tripped
      ? `🚨 BREAKER TRIPPED — ${Math.floor(s.circuitBreaker.cooldownSecondsRemaining/60)}m left`
      : '';
    const danger = s.lastDanger ?? '?';
    const targetStr = s.targetModes.map((m,i) =>
      `c${i+1}=${['E','A','D'][m] ?? '?'}`
    ).join(' ');

    return {
      text:
`*🤖 Offshore Bot — Main Menu*

State: ${stateEmoji}
Active: \`${s.activePresetName}\` (${s.scheduleMode})
Targets: ${targetStr}
HKT: ${s.hktHour.toString().padStart(2,'0')}h → \`${s.schedulePresetThisHour ?? 'off'}\`
Danger: ${danger}/100${breaker ? '\n\n' + breaker : ''}

Tap a button:`,
      rows: [
        [{text:'📊 Full Status', data:'menu:status'}, {text:'💰 Wallet', data:'menu:wallet'}],
        [{text:'🎯 Presets',     data:'menu:presets'}, {text:'📅 Schedule', data:'menu:schedule'}],
        [{text:'🔌 Breaker',     data:'menu:breaker'}, {text:'⚙️ Config',  data:'menu:config'}],
        [{text:'💸 Claim Now',   data:'action:claim'}, {text:s.paused ? '▶️ Resume' : '⏸ Pause', data:s.paused ? 'action:resume' : 'action:pause'}],
        [{text:'📋 Recent Logs', data:'menu:logs'},    {text:'🔄 Refresh', data:'menu:main'}],
      ],
    };
  }

  private renderStatusMenu(): { text: string; rows: IKBtn[][] } {
    const cb = this.cfg.corpBot;
    if (!cb) return { text: 'Trading bot disabled.', rows: [[{text:'← Back',data:'menu:main'}]] };
    const s = cb.getStatus();

    const fmt = (n: number, dec=2) => n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    const balLine = s.balances
      ? `INF: \`${fmt(s.balances.inf, 0)}\` · DIRTY: \`${fmt(s.balances.dirty, 0)}\` · USDM: \`${fmt(s.balances.usdm, 0)}\``
      : '_(balances warming up)_';
    const corps = s.perCorp.length === 0
      ? '  _(no data yet)_'
      : s.perCorp.map(c => `  \`${c.addr.slice(0,10)}..\` ${c.auto ? '✅' : '❌'} ${c.modeName}`).join('\n');

    return {
      text:
`*📊 Full Status*

State: ${s.running ? (s.paused ? '⏸ Paused' : '▶️ Running') : '⛔ Stopped'}
Owns: ${s.ownedCorps}/${s.totalCorps} corps
Active preset: \`${s.activePresetName}\` (${s.scheduleMode})

Schedule: ${s.scheduleEnabled ? 'ON' : 'OFF'} · ${s.hktHour.toString().padStart(2,'0')}h HKT → \`${s.schedulePresetThisHour ?? '—'}\`
Danger thresholds: panic ≥${s.panicThreshold} · band ${s.dangerLow}/${s.dangerHigh}
Last danger: ${s.lastDanger ?? '—'}

*Wallet:*
${balLine}

*Per-corp:*
${corps}`,
      rows: [
        [{text:'🔄 Refresh', data:'menu:status'}, {text:'← Back', data:'menu:main'}],
      ],
    };
  }

  private renderPresetsMenu(): { text: string; rows: IKBtn[][] } {
    const cb = this.cfg.corpBot;
    if (!cb) return { text: 'Trading bot disabled.', rows: [[{text:'← Back',data:'menu:main'}]] };
    const s = cb.getStatus();
    const presets = cb.listPresets();

    // 2 buttons per row
    const rows: IKBtn[][] = [];
    let row: IKBtn[] = [];
    for (const p of presets) {
      const marker = (s.activePresetName === `manual:${p.name}` || s.activePresetName.endsWith(':' + p.name)) ? '● ' : '';
      row.push({ text: `${marker}${p.name}`, data: `preset:set:${p.name}` });
      if (row.length === 2) { rows.push(row); row = []; }
    }
    if (row.length) rows.push(row);
    rows.push([{text:'🔄 Auto (schedule)', data:'preset:set:auto'}]);
    rows.push([{text:'← Back', data:'menu:main'}]);

    return {
      text:
`*🎯 Presets*

Active: \`${s.activePresetName}\` (${s.scheduleMode})

Tap to lock in. *Auto* releases the lock and follows schedule.

\`all-drug\` = all corps Drug · \`all-arms\` = all Arms
\`mix-arms\` = ${Math.round(s.targetModes.length * 2/3)} Arms + ${Math.max(1, Math.round(s.targetModes.length / 3))} Drug
\`paused\` = auto-trade off`,
      rows,
    };
  }

  private renderScheduleMenu(): { text: string; rows: IKBtn[][] } {
    const cb = this.cfg.corpBot;
    if (!cb) return { text: 'Trading bot disabled.', rows: [[{text:'← Back',data:'menu:main'}]] };
    const s = cb.getStatus();
    const sched = cb.getSchedule();

    // Compact 24h view — group consecutive identical hours
    const ranges: { start: number; end: number; preset: string }[] = [];
    for (let h = 0; h < 24; h++) {
      const last = ranges[ranges.length - 1];
      if (last && last.preset === sched[h] && last.end === h - 1) last.end = h;
      else ranges.push({ start: h, end: h, preset: sched[h] });
    }
    const lines = ranges.map(r => {
      const label = r.start === r.end ? `${r.start.toString().padStart(2,'0')}h    ` : `${r.start.toString().padStart(2,'0')}-${r.end.toString().padStart(2,'0')}h`;
      const marker = (r.start <= s.hktHour && s.hktHour <= r.end) ? ' ←' : '';
      return `  ${label}  \`${r.preset}\`${marker}`;
    }).join('\n');

    return {
      text:
`*📅 HKT Schedule* — ${s.scheduleEnabled ? '✅ ENABLED' : '⏸ DISABLED'}

${lines}

Now: ${s.hktHour.toString().padStart(2,'0')}h HKT`,
      rows: [
        [{text: s.scheduleEnabled ? '⏸ Disable Schedule' : '✅ Enable Schedule', data:'schedule:toggle'}],
        [{text:'🔄 Refresh', data:'menu:schedule'}, {text:'← Back', data:'menu:main'}],
      ],
    };
  }

  private renderBreakerMenu(): { text: string; rows: IKBtn[][] } {
    const cb = this.cfg.corpBot;
    if (!cb) return { text: 'Trading bot disabled.', rows: [[{text:'← Back',data:'menu:main'}]] };
    const s = cb.getStatus();
    const b = s.circuitBreaker;
    const stateLine = b.tripped
      ? `🚨 *TRIPPED* — clears in ${Math.floor(b.cooldownSecondsRemaining/60)}m ${b.cooldownSecondsRemaining%60}s`
      : `✅ Armed`;

    const rows: IKBtn[][] = [];
    if (b.tripped) rows.push([{text:'⚠️ Clear Now', data:'breaker:clear'}]);
    rows.push([{text:'🔄 Refresh', data:'menu:breaker'}, {text:'← Back', data:'menu:main'}]);

    return {
      text:
`*🔌 Circuit Breaker*

State: ${stateLine}
Window: ${(b.windowSeconds/60).toFixed(1)} min
Threshold: ${b.threshold} distinct corps
Cooldown when tripped: ${Math.round(this.cfg.corpBot ? b.windowSeconds*0+30 : 30)} min
Pressure: *${b.recentLiquidationCount}/${b.threshold}* corps liquidated in window
Total trips this session: ${b.totalTrips}

The breaker watches your corps' liquidations. If ≥${b.threshold} corps liquidate within ${(b.windowSeconds/60).toFixed(1)}m, it forces auto-trade off until cooldown clears.`,
      rows,
    };
  }

  private renderWalletMenu(): { text: string; rows: IKBtn[][] } {
    const cb = this.cfg.corpBot;
    if (!cb) return { text: 'Trading bot disabled.', rows: [[{text:'← Back',data:'menu:main'}]] };
    const s = cb.getStatus();
    if (!s.balances) {
      return {
        text: '*💰 Wallet*\n\n_Balances warming up..._',
        rows: [[{text:'🔄 Refresh', data:'menu:wallet'}, {text:'← Back', data:'menu:main'}]],
      };
    }
    const fmt = (n: number, dec=2) => n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    const rate = (r: number | null, suffix: string) => r === null ? '' : ` (${r >= 0 ? '+' : ''}${fmt(r, 1)}${suffix})`;

    // INF runway approximation
    let runway = '';
    if (s.balances.infPerHr !== null && s.balances.infPerHr < 0 && s.balances.inf > 25) {
      const hrs = (s.balances.inf - 25) / Math.abs(s.balances.infPerHr);
      runway = `\nINF runway: *${hrs < 1 ? `${(hrs*60).toFixed(0)}m` : `${hrs.toFixed(1)}h`}* to 25 floor`;
    }

    return {
      text:
`*💰 Wallet*

INF:    \`${fmt(s.balances.inf)}\`${rate(s.balances.infPerHr, '/hr')}
DIRTY:  \`${fmt(s.balances.dirty)}\`${rate(s.balances.dirtyPerHr, '/hr')}
USDM:   \`${fmt(s.balances.usdm)}\`${rate(s.balances.usdmPerHr, '/hr')}${runway}`,
      rows: [
        [{text:'💸 Claim Now', data:'action:claim'}],
        [{text:'🔄 Refresh', data:'menu:wallet'}, {text:'← Back', data:'menu:main'}],
      ],
    };
  }

  private renderConfigMenu(): { text: string; rows: IKBtn[][] } {
    const cb = this.cfg.corpBot;
    if (!cb) return { text: 'Trading bot disabled.', rows: [[{text:'← Back',data:'menu:main'}]] };
    const s = cb.getStatus();
    return {
      text:
`*⚙️ Config*

Danger thresholds: ${s.dangerLow}/${s.dangerHigh}
Panic threshold: ≥${s.panicThreshold}
Schedule: ${s.scheduleEnabled ? 'ON' : 'OFF'}

Type commands to change values:
\`/bot thresholds <high> <low>\`
\`/bot panic <threshold>\`
\`/bot breaker config <window> <thr> <cool>\``,
      rows: [
        [{text:'← Back', data:'menu:main'}],
      ],
    };
  }

  private renderLogsMenu(): { text: string; rows: IKBtn[][] } {
    const cb = this.cfg.corpBot;
    if (!cb) return { text: 'Trading bot disabled.', rows: [[{text:'← Back',data:'menu:main'}]] };
    const s = cb.getStatus();
    const recent = s.recentLogs.slice(-15);
    const body = recent.length === 0
      ? '_(no recent log entries)_'
      : '```\n' + recent.map(l => l.length > 90 ? l.slice(0, 87) + '...' : l).join('\n') + '\n```';
    return {
      text: `*📋 Recent Logs*\n\n${body}`,
      rows: [
        [{text:'🔄 Refresh', data:'menu:logs'}, {text:'← Back', data:'menu:main'}],
      ],
    };
  }

  /** Route a callback_query click to the right handler and edit the message. */
  private async handleCallback(cq: TgCallbackQuery): Promise<void> {
    if (!cq.data || !cq.message) { await this.ackCallback(cq.id); return; }

    // Operator-only gate — same as cmdBot
    if (!this.cfg.operatorChatId || cq.from.id !== this.cfg.operatorChatId) {
      await this.ackCallback(cq.id, 'Not authorized');
      return;
    }

    const cb = this.cfg.corpBot;
    if (!cb) { await this.ackCallback(cq.id, 'Bot offline'); return; }

    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;
    const [type, action, ...rest] = cq.data.split(':');

    try {
      if (type === 'menu') {
        let view;
        switch (action) {
          case 'main':     view = this.renderMainMenu(); break;
          case 'status':   view = this.renderStatusMenu(); break;
          case 'presets':  view = this.renderPresetsMenu(); break;
          case 'schedule': view = this.renderScheduleMenu(); break;
          case 'breaker':  view = this.renderBreakerMenu(); break;
          case 'wallet':   view = this.renderWalletMenu(); break;
          case 'config':   view = this.renderConfigMenu(); break;
          case 'logs':     view = this.renderLogsMenu(); break;
          default:         view = this.renderMainMenu();
        }
        await this.editKb(chatId, messageId, view.text, view.rows);
        await this.ackCallback(cq.id);
        return;
      }

      if (type === 'preset' && action === 'set') {
        const name = rest[0] || 'auto';
        const res = cb.setManualPreset(name);
        await this.ackCallback(cq.id, res.ok ? `→ ${name}` : (res.reason ?? 'failed'));
        // Re-render presets menu to reflect new state
        const view = this.renderPresetsMenu();
        await this.editKb(chatId, messageId, view.text, view.rows);
        return;
      }

      if (type === 'schedule' && action === 'toggle') {
        const cur = cb.getStatus().scheduleEnabled;
        cb.setScheduleEnabled(!cur);
        await this.ackCallback(cq.id, !cur ? 'Schedule ON' : 'Schedule OFF');
        const view = this.renderScheduleMenu();
        await this.editKb(chatId, messageId, view.text, view.rows);
        return;
      }

      if (type === 'breaker' && action === 'clear') {
        const r = cb.clearCircuitBreaker();
        await this.ackCallback(cq.id, r.wasTripped ? 'Cleared' : 'Was not tripped');
        const view = this.renderBreakerMenu();
        await this.editKb(chatId, messageId, view.text, view.rows);
        return;
      }

      if (type === 'action') {
        if (action === 'pause') {
          cb.pause();
          await this.ackCallback(cq.id, 'Bot paused');
        } else if (action === 'resume') {
          cb.resume();
          await this.ackCallback(cq.id, 'Bot resumed');
        } else if (action === 'claim') {
          await this.ackCallback(cq.id, 'Claiming...');
          const results = await cb.forceClaim();
          const claimed = results.filter(r => r.tx);
          const summary = claimed.length === 0
            ? '_(no pending rewards on any corp)_'
            : claimed.map(r => `${r.corp.slice(0,10)}.. → ${(r.reward ?? 0).toFixed(0)} DIRTY`).join('\n');
          await this.sendDm(chatId, `*Claim results:*\n${summary}`);
        }
        // Refresh main menu after any action
        const view = this.renderMainMenu();
        await this.editKb(chatId, messageId, view.text, view.rows);
        return;
      }

      if (type === 'cliff') {
        // Threshold-cliff alert action buttons (from sendThresholdCliffAlert).
        // Operator clicks one of: pause | dismiss.
        if (action === 'pause') {
          cb.pause();
          // Edit the original alert message to remove the keyboard and
          // append a confirmation line. Markdown-safe — no user input.
          const originalText = cq.message.text ?? 'Threshold cliff alert';
          // Telegram's edit returns 'message is not modified' if text + reply_markup
          // are unchanged; we always append text so it's always modified.
          await this.api('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: originalText + '\n\n✓ *Bot paused* — no new bootstraps until you run `/bot resume`.',
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            // Empty reply_markup removes the inline keyboard
            reply_markup: { inline_keyboard: [] },
          }).catch(() => { /* tolerate edit failures */ });
          await this.ackCallback(cq.id, 'Bot paused');
          return;
        }
        if (action === 'dismiss') {
          const originalText = cq.message.text ?? 'Threshold cliff alert';
          await this.api('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: originalText + '\n\n_(alert dismissed — bot still running)_',
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: [] },
          }).catch(() => { /* tolerate edit failures */ });
          await this.ackCallback(cq.id, 'Dismissed');
          return;
        }
        await this.ackCallback(cq.id, 'Unknown cliff action');
        return;
      }

      await this.ackCallback(cq.id, 'Unknown action');
    } catch (err: any) {
      logger.error({ err: err.message, data: cq.data }, '[TgBot] callback handler threw');
      await this.ackCallback(cq.id, 'Error');
    }
  }
}
