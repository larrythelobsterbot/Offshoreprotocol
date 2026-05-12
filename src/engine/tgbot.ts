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
  // Optional HedgeBot reference for /bot hedge subcommands. Independent
  // of CorpBot — present even on deployments where the bot signs no
  // trades, since shadow logging is non-destructive.
  hedgeBot?: import('./hedge-bot').HedgeBot | null;
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

  /** Attach the HedgeBot reference (built after TgBot in src/index.ts). */
  attachHedgeBot(hedgeBot: import('./hedge-bot').HedgeBot) {
    this.cfg.hedgeBot = hedgeBot;
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

  /**
   * Full subsystem dump — per-corp on-chain state, locks, grace timers,
   * SafetyGate, INF cost. Pre-revamp `/bot status` contents, now reachable
   * via `/bot systems`. Pure-string output (no inline keyboard).
   */
  private composeSystemsDump(corpBot: CorpBot): string {
    const s = corpBot.getStatus();
    const fmt = (n: number, dec = 2) => n.toLocaleString('en-US', {
      minimumFractionDigits: dec, maximumFractionDigits: dec,
    });
    const rate = (r: number | null, suffix: string) =>
      r === null ? '' : ` _(${r >= 0 ? '+' : ''}${fmt(r, 1)}${suffix})_`;

    const corps = s.perCorp.length === 0
      ? '  _(no corp data yet)_'
      : s.perCorp.map(c =>
          `  \`${c.addr.slice(0, 10)}..\` ${c.auto ? '✅' : '❌'} ${c.modeName}`
        ).join('\n');

    const balancesBlock = s.balances
      ? `*Wallet:*
  INF:    \`${fmt(s.balances.inf)}\`${rate(s.balances.infPerHr,   '/hr')}
  DIRTY:  \`${fmt(s.balances.dirty)}\`${rate(s.balances.dirtyPerHr, '/hr')}
  USDM:   \`${fmt(s.balances.usdm)}\`${rate(s.balances.usdmPerHr,  '/hr')}`
      : '_(wallet balances warming up)_';

    const opParams = (this.cfg.getState?.() as any)?.opParams;
    const infCostBlock = opParams?.infCostPerOp
      ? `*INF cost/op:* \`${opParams.infCostPerOp.toFixed(2)}\` _(n=${opParams.infCostSampleCount ?? 0})_`
      : '';

    const locked = corpBot.getLockedCorps();
    const overrides = corpBot.getOperatorOverrides();
    const lockLines: string[] = [];
    if (locked.length > 0) {
      const labels = locked.map(addr => {
        const idx = s.perCorp.findIndex(c => c.addr.toLowerCase() === addr) + 1;
        return idx > 0 ? '#' + idx : addr.slice(0, 8);
      }).join(', ');
      lockLines.push(`*Locked corps:* 🔒 ${labels}`);
    }
    if (overrides.length > 0) {
      const lines = overrides.map(o => {
        const idx = s.perCorp.findIndex(c => c.addr.toLowerCase() === o.corp) + 1;
        const m = Math.ceil(o.remainingMs / 60_000);
        return `  ${idx > 0 ? '#' + idx : o.corp.slice(0,8)} (${m}m remaining)`;
      }).join('\n');
      lockLines.push(`*Operator grace:* ✋\n${lines}`);
    }

    const scores = (this.cfg.getState?.() as any)?.scores;
    let gateBlock = '';
    try {
      if (!appConfig.safetyGateDisabled) {
        const sinceMs = Date.now() - 24 * 3600_000;
        const rollup = this.cfg.storage?.getSafetyGateRollup(sinceMs) ?? [];
        const allow = rollup.find(r => r.decision === 'allow')?.n ?? 0;
        const block = rollup.find(r => r.decision === 'block')?.n ?? 0;
        const mode = appConfig.safetyGateShadow ? 'SHADOW' : 'LIVE';
        const fmtScore = (n: number | null | undefined) => n == null ? '—' : n.toFixed(0);
        gateBlock =
          `*SafetyGate* \`${mode}\` · scores Ext=${fmtScore(scores?.extortion)} ` +
          `Arms=${fmtScore(scores?.arms)} Drug=${fmtScore(scores?.drug)}\n` +
          `  thresholds: Drug≥${appConfig.safetyGateDrugThreshold || 'OFF'} · ` +
          `Arms≥${appConfig.safetyGateArmsThreshold || 'OFF'} · Ext≥${appConfig.safetyGateExtThreshold || 'OFF'}\n` +
          `  24h: ${allow} allow · ${block} would-block`;
      }
    } catch { /* tolerate */ }

    const breakerLine = s.circuitBreaker.tripped
      ? `🚨 *Breaker TRIPPED* — clears in ${Math.floor(s.circuitBreaker.cooldownSecondsRemaining / 60)}m`
      : s.circuitBreaker.recentLiquidationCount > 0
        ? `Breaker pressure: ${s.circuitBreaker.recentLiquidationCount}/${s.circuitBreaker.threshold} in last ${(s.circuitBreaker.windowSeconds/60).toFixed(0)}m`
        : '';

    const parts = [
      `*🔧 Systems dump*`,
      `Signer: \`${s.signer ?? '(none)'}\``,
      `Owns: ${s.ownedCorps}/${s.totalCorps} corps`,
      breakerLine,
      ...lockLines,
      infCostBlock,
      gateBlock,
      balancesBlock,
      `*Per-corp on-chain:*\n${corps}`,
    ].filter(Boolean);

    return parts.join('\n\n');
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
          // Use the unified rich status view (same one served via the
          // inline-keyboard menu) so the text command and the GUI never
          // drift. Per-corp / SafetyGate / locked-corps detail moved to
          // `/bot systems` for operators who want the full dump.
          const { text, rows } = this.renderStatusMenu();
          await this.sendDmKb(chatId, text, rows);
          return;
        }

        case 'systems': {
          // Full subsystem dump — per-corp on-chain state, locked corps,
          // grace timers, SafetyGate, INF cost. The pre-revamp /bot status
          // contents, now opt-in via /bot systems.
          await this.sendDm(chatId, this.composeSystemsDump(corpBot));
          return;
        }

        case 'help': {
          await this.sendDm(chatId,
`*🤖 Corp Bot — admin commands*

*State:*
\`/bot\` — rich status (P&L · fleet · danger · cycle · wallet)
\`/bot systems\` — full subsystem dump (per-corp · safety gate · locks)
\`/bot logs\` — last 20 CorpBot log lines
\`/bot claim\` — claim pending rewards on all corps now
\`/bot eff [hours]\` — on-demand INF efficiency DM (default 24h)
\`/bot quiet on|off|status\` — mute low-signal DMs (claims, mode-switches, etc) keeping only critical alerts + daily digest
\`/bot hedge [on|off|shadow|live|stats]\` — World Exchange hedge controls (shadow mode default; live requires confirm)
\`/bot whales\` — whale confidence signal (aggregate SR, per-wallet, outcomes)
   ↳ \`/bot whales outcomes\` — last 20 whale outcomes
   ↳ \`/bot whales config\`   — show thresholds & shadow/live mode

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

*Schedule (HKT-based, regime-aware v4):*
\`/bot schedule\` — show BOTH weekday + weekend arrays side by side
\`/bot schedule weekday|weekend\` — show one regime
\`/bot schedule on|off\` — toggle scheduling
   ↳ when OFF: bot stops trading (paused fallback). Use \`/bot drug\` etc. to manually run.
\`/bot schedule <hour|range> <preset>\` — set BOTH regimes (e.g. \`/bot schedule 21-22 paused\`)
\`/bot schedule weekday <hour|range> <preset>\` — weekday only
\`/bot schedule weekend <hour|range> <preset>\` — weekend only

*Graduated scaling (danger-driven corp count):*
\`/bot graduated\` — show current level + thresholds
\`/bot graduated on|off\` — toggle (default: on)
\`/bot graduated levels 40:6,60:3,75:0\` — \`danger:corps\` thresholds

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
          // Subcommands:
          //   /bot schedule                       — show BOTH regimes side-by-side
          //   /bot schedule weekday               — show weekday only
          //   /bot schedule weekend               — show weekend only
          //   /bot schedule on|off                — toggle scheduler
          //   /bot schedule <hour> <preset>       — set BOTH regimes
          //   /bot schedule weekday <hour> <preset>
          //   /bot schedule weekend <hour> <preset>
          const a1 = (parts[1] || '').toLowerCase();

          // Schedule on/off — apply to whole scheduler (unchanged)
          if (a1 === 'on') {
            corpBot.setScheduleEnabled(true);
            await this.sendDm(chatId, `✅ Schedule ENABLED. Bot will follow HKT schedule.`);
            return;
          }
          if (a1 === 'off') {
            corpBot.setScheduleEnabled(false);
            await this.sendDm(chatId,
              `⏸ Schedule DISABLED. Bot falls back to \`paused\` — auto-trade off on every corp on the next tick.\n\n` +
              `Use \`/bot schedule on\` to resume the HKT schedule, or set a manual preset.`);
            return;
          }

          // Regime selector for read OR write
          const isRegime = a1 === 'weekday' || a1 === 'weekend';
          const regime: 'weekday' | 'weekend' | null = isRegime ? (a1 as 'weekday' | 'weekend') : null;

          // Build a compact "ranges" view for one or both arrays.
          const cfg = corpBot.getScheduleConfig();
          const cur = corpBot.getCurrentRegime();
          const status = corpBot.getStatus();
          const fmt = (label: 'weekday' | 'weekend') => {
            const sched = cfg[label];
            const ranges: { start: number; end: number; preset: string }[] = [];
            for (let h = 0; h < 24; h++) {
              const last = ranges[ranges.length - 1];
              if (last && last.preset === sched[h] && last.end === h - 1) last.end = h;
              else ranges.push({ start: h, end: h, preset: sched[h] });
            }
            return ranges.map(r => {
              const range = r.start === r.end
                ? `${String(r.start).padStart(2,'0')}h    `
                : `${String(r.start).padStart(2,'0')}h-${String(r.end).padStart(2,'0')}h`;
              const arrow = (cur === label && r.start <= status.hktHour && status.hktHour <= r.end) ? ' ←' : '';
              return `  ${range}  \`${r.preset}\`${arrow}`;
            }).join('\n');
          };

          // Show variants: nothing-or-show, weekday-only, weekend-only
          const showOnly = !parts[1] || a1 === 'show'
            || (isRegime && !parts[2]);
          if (showOnly) {
            if (!isRegime) {
              await this.sendDm(chatId,
                `*HKT Schedule* (${status.scheduleEnabled ? 'ENABLED' : 'DISABLED'})  ·  now: *${cur.toUpperCase()}* ${String(status.hktHour).padStart(2,'0')}h\n\n` +
                `*Weekday:*\n${fmt('weekday')}\n\n*Weekend:*\n${fmt('weekend')}`);
            } else {
              await this.sendDm(chatId,
                `*HKT Schedule — ${a1.toUpperCase()}* (${status.scheduleEnabled ? 'ENABLED' : 'DISABLED'})\n\n${fmt(regime!)}`);
            }
            return;
          }

          // Write paths:
          //   /bot schedule weekday <hour> <preset>
          //   /bot schedule <hour> <preset>
          const hourSpec = isRegime ? (parts[2] || '') : (parts[1] || '');
          const presetName = isRegime ? (parts[3] || '') : (parts[2] || '');
          if (!hourSpec || !presetName) {
            await this.sendDm(chatId,
              'Usage:\n' +
              '  `/bot schedule <hour|range> <preset>`               — both regimes\n' +
              '  `/bot schedule weekday <hour|range> <preset>`       — weekday only\n' +
              '  `/bot schedule weekend <hour|range> <preset>`       — weekend only\n' +
              'Examples:\n' +
              '  `/bot schedule 21-22 paused`\n' +
              '  `/bot schedule weekend 14 all-arms`');
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

          const which: 'weekday' | 'weekend' | 'both' = regime ?? 'both';
          const res = corpBot.setScheduleHours(hours, presetName, which);
          if (!res.ok) {
            await this.sendDm(chatId, `❌ ${res.reason}`);
          } else {
            await this.sendDm(chatId,
              `✅ Schedule updated (${which}): hours \`${hourSpec}\` → \`${presetName}\``);
          }
          return;
        }

        case 'graduated':
        case 'grad': {
          const action = (parts[1] || 'status').toLowerCase();
          const g = corpBot.getGraduatedState();

          if (action === 'status' || action === 'show' || !action) {
            const lvlStr = g.levels.map(l => `${l.danger}:${l.corps}`).join(',');
            const paused = g.pausedCorps.length > 0
              ? g.pausedCorps.map(a => '`'+a.slice(0,10)+'..`').join(', ')
              : '_none_';
            await this.sendDm(chatId,
              `*Graduated scaling* — ${g.enabled ? '✅ ON' : '⏸ OFF'}\n\n` +
              `Current level: *${g.currentLevel}*\n` +
              `Active corps: *${g.currentTarget}/${g.totalCorps}*\n` +
              `Thresholds: \`${lvlStr}\`  (hysteresis ${g.hysteresis}pp)\n` +
              `Pause priority: ${g.priority} first\n` +
              `Paused by graduated: ${paused}\n\n` +
              `Commands:\n` +
              `  \`/bot graduated on|off\`\n` +
              `  \`/bot graduated levels 40:6,60:3,75:0\``);
            return;
          }
          if (action === 'on') {
            corpBot.setGraduatedEnabled(true);
            await this.sendDm(chatId, `✅ Graduated scaling ENABLED.`);
            return;
          }
          if (action === 'off') {
            corpBot.setGraduatedEnabled(false);
            await this.sendDm(chatId,
              `⏸ Graduated scaling DISABLED. Bot reverts to binary all-on / panic-off behaviour.`);
            return;
          }
          if (action === 'levels') {
            const spec = parts.slice(2).join(' ').trim();
            if (!spec) {
              await this.sendDm(chatId, 'Usage: `/bot graduated levels 40:6,60:3,75:0`');
              return;
            }
            const res = corpBot.setGraduatedLevels(spec);
            if (!res.ok) {
              await this.sendDm(chatId, `❌ ${res.reason}`);
            } else {
              await this.sendDm(chatId,
                `✅ Levels updated: \`${(res.levels ?? []).map(l => l.danger+':'+l.corps).join(',')}\``);
            }
            return;
          }
          await this.sendDm(chatId, 'Usage: `/bot graduated [status|on|off|levels <spec>]`');
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

        case 'hedge': {
          // World Exchange hedge controls. Phase 1 ships shadow-only;
          // /bot hedge live is wired but the live execution path is
          // intentionally not yet implemented (Phase 2). Confirmation
          // required for state transitions that could lead to real
          // trades.
          const hedge = this.cfg.hedgeBot;
          if (!hedge) {
            await this.sendDm(chatId, '_Hedge bot is not running on this deployment._');
            return;
          }
          const sub2 = (parts[1] || 'status').toLowerCase();
          if (sub2 === 'status' || sub2 === '') {
            const s = hedge.getState();
            const last = s.lastSizing;
            const lines: string[] = [
              `*🛡 Hedge status*`,
              `enabled: *${s.enabled ? 'YES' : 'no'}*  ·  mode: *${s.mode.toUpperCase()}*${s.disabled ? '  ·  ⚠ disabled' : ''}`,
            ];
            if (s.activeHedge) {
              const a = s.activeHedge;
              lines.push('');
              lines.push(`Active${s.mode === 'shadow' ? ' (shadow)' : ''}:`);
              lines.push(`  corps: ${a.corpsHedged.length}  ·  notional: \`$${a.notional.toFixed(0)}\`  ·  margin: \`$${a.margin.toFixed(0)}\``);
              lines.push(`  entry: \`$${a.entryPrice.toFixed(2)}\`  ·  TP: \`$${a.takeProfitPrice.toFixed(2)}\``);
            } else {
              lines.push('  (no active hedge)');
            }
            if (last) {
              lines.push('');
              lines.push(`Last sizing computation:`);
              lines.push(`  corps: ${last.corpsActive}  ·  INF at risk: \`${last.totalInfAtRisk.toFixed(1)}\``);
              lines.push(`  drug threshold: \`${(last.drugThreshold * 100).toFixed(4)}%\`  ·  ETH: \`$${last.ethPrice.toFixed(2)}\``);
              lines.push(`  → notional \`$${last.notional.toFixed(0)}\`  ·  margin \`$${last.margin.toFixed(0)}\`  ·  TP \`$${last.takeProfitPrice.toFixed(2)}\``);
            }
            lines.push('');
            lines.push(`Subcommands: \`/bot hedge on|off|shadow|live|stats\``);
            await this.sendDm(chatId, lines.join('\n'));
            return;
          }
          if (sub2 === 'on') {
            hedge.setEnabled(true);
            await this.sendDm(chatId, `🛡 Hedge *enabled* (mode: *${hedge.getState().mode.toUpperCase()}*).`);
            return;
          }
          if (sub2 === 'off') {
            hedge.setEnabled(false);
            await this.sendDm(chatId, `🛡 Hedge *disabled*.`);
            return;
          }
          if (sub2 === 'shadow') {
            hedge.setMode('shadow');
            await this.sendDm(chatId, `🛡 Hedge mode: *SHADOW* (logging only, no trades).`);
            return;
          }
          if (sub2 === 'live') {
            // Two-step confirm because live mode trades real money.
            const arg3 = (parts[2] || '').toLowerCase();
            if (arg3 !== 'confirm') {
              const s = hedge.getState();
              const last = s.lastSizing;
              await this.sendDm(chatId,
                `⚠️ *Switching the hedge to LIVE will execute real trades on World Exchange.*\n\n` +
                (last
                  ? `Most recent sizing would have opened: \`$${last.notional.toFixed(0)}\` notional · \`$${last.margin.toFixed(0)}\` margin · TP \`$${last.takeProfitPrice.toFixed(2)}\`.\n\n`
                  : '') +
                `*Pre-requisites:*\n` +
                `  1. \`npm run world-poc\` completed successfully (POC validates SDK integration)\n` +
                `  2. Dashboard shadow stats look right vs your expectations\n` +
                `  3. Sufficient USDM deposited on World Exchange (~3000 at 9 corps)\n\n` +
                `Confirm with: \`/bot hedge live confirm\``);
              return;
            }
            // The live execution path itself is Phase 2 — for now we
            // flip the mode flag so the operator can see the toggle
            // works, but onDrugBatchStart will log an error if it tries
            // to actually trade and fall back to a shadow row.
            hedge.setMode('live');
            await this.sendDm(chatId,
              `🛡 Hedge mode: *LIVE*.\n\n` +
              `_Note: live execution wiring (the SDK call to open/close on World) is not yet implemented. The bot will fall back to shadow logging until Phase 2 ships._\n\n` +
              `Revert: \`/bot hedge shadow\``);
            return;
          }
          if (sub2 === 'policy') {
            const want = (parts[2] || '').toLowerCase();
            const valid: ReadonlyArray<'danger-only' | 'us-hours' | 'always' | 'off'> =
              ['danger-only', 'us-hours', 'always', 'off'] as const;
            if (!want) {
              await this.sendDm(chatId,
                `Current policy: *${hedge.getActivationPolicy()}*  ·  minDanger: *${hedge.getMinDanger()}*\n\n` +
                `Set: \`/bot hedge policy <danger-only|us-hours|always|off>\``);
              return;
            }
            if (!valid.includes(want as any)) {
              await this.sendDm(chatId, `❌ Unknown policy. Valid: ${valid.join(', ')}`);
              return;
            }
            hedge.setActivationPolicy(want as 'danger-only' | 'us-hours' | 'always' | 'off');
            await this.sendDm(chatId, `🛡 Activation policy → *${want}*.`);
            return;
          }
          if (sub2 === 'danger') {
            const n = parseInt(parts[2] ?? '', 10);
            if (!Number.isFinite(n)) {
              await this.sendDm(chatId,
                `Current minDanger: *${hedge.getMinDanger()}*\n\n` +
                `Set: \`/bot hedge danger <0-100>\``);
              return;
            }
            const r = hedge.setMinDanger(n);
            if (!r.ok) await this.sendDm(chatId, `❌ ${r.reason}`);
            else      await this.sendDm(chatId, `🛡 minDanger → *${n}*.`);
            return;
          }
          if (sub2 === 'stats') {
            const s = hedge.getState();
            const st = s.stats;
            const triggerRate = st.totalShadowCloses > 0
              ? (st.triggered / st.totalShadowCloses) * 100
              : 0;
            const winRate = st.totalShadowCloses > 0
              ? (st.wouldProfit / st.totalShadowCloses) * 100
              : 0;
            await this.sendDm(chatId,
              `*🛡 Hedge stats (last 30d shadow)*\n\n` +
              `Opens: *${st.totalShadowOpens}*  ·  Closes: *${st.totalShadowCloses}*\n` +
              `Triggered (any op failed): *${st.triggered}* (${triggerRate.toFixed(0)}%)\n` +
              `Would have profited: *${st.wouldProfit}* (${winRate.toFixed(0)}%)\n\n` +
              `Theoretical P&L: \`$${st.totalShadowPnl.toFixed(2)}\`  (after \`$${st.totalShadowFees.toFixed(0)}\` est. fees)`);
            return;
          }
          await this.sendDm(chatId, `Unknown hedge action: \`${sub2}\`. Try \`/bot hedge\`.`);
          return;
        }

        case 'nh': {
          // NetworkHealth → graduated-penalty controls. Reports current
          // penalty + shadow flag; lets the operator toggle shadow-mode.
          // The penalty value itself + fade window live in env / config
          // (BOT_NH_DANGER_PENALTY etc) — no runtime mutability here yet
          // to avoid making them drift between processes.
          const sub2 = (parts[1] || 'status').toLowerCase();
          const pen = corpBot.getNhPenalty();
          const raw = corpBot.getStatus().lastDanger ?? 0;
          const eff = corpBot.getEffectiveDanger();
          const shadow = appConfig.botNhGraduatedShadow;
          if (sub2 === 'status' || sub2 === '') {
            await this.sendDm(chatId,
              `*🌊 NetworkHealth → Graduated penalty*\n\n` +
              `Mode: *${shadow ? 'SHADOW (log only)' : 'LIVE'}*\n` +
              `Raw danger: *${raw}*  ·  NH penalty: *+${pen}*  →  effective: *${eff}*\n` +
              `Penalty config: full ${appConfig.botNhDangerPenalty} for ${appConfig.botNhFullMinutes}min, fade to 0 at ${appConfig.botNhFadeMinutes}min.\n\n` +
              `Toggle: \`/bot nh shadow\` or \`/bot nh live\` (env: BOT_NH_GRADUATED_SHADOW)`);
            return;
          }
          if (sub2 === 'shadow' || sub2 === 'live') {
            await this.sendDm(chatId,
              `Setting BOT_NH_GRADUATED_SHADOW at runtime requires editing .env + pm2 restart.\n` +
              `Current: ${shadow ? 'shadow' : 'live'}.`);
            return;
          }
          await this.sendDm(chatId, 'Usage: `/bot nh [status]`');
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

        case 'whales': {
          // Whale confidence panel — aggregate SR, per-wallet breakdown,
          // recent outcomes ticker. Two subcommands:
          //   /bot whales            full panel
          //   /bot whales outcomes   last 20 outcomes (wallet + mode + ✓/✗)
          //   /bot whales config     show current thresholds
          const sub2 = (parts[1] || '').toLowerCase();
          const state = this.cfg.getState?.() as any;
          const wc = state?.whaleConfidence;
          if (sub2 === 'config') {
            await this.sendDm(chatId,
`*🐋 Whale confidence config*

Thresholds (SR fractions):
  green ≥ ${appConfig.whaleConfidenceGreenSr.toFixed(2)}
  yellow ≥ ${appConfig.whaleConfidenceYellowSr.toFixed(2)}
  orange ≥ ${appConfig.whaleConfidenceOrangeSr.toFixed(2)}
  red < ${appConfig.whaleConfidenceOrangeSr.toFixed(2)}

Modifiers (danger delta):
  green = ${appConfig.whaleConfidenceGreenMod}
  yellow = 0
  orange = ${appConfig.whaleConfidenceOrangeMod}
  red = ${appConfig.whaleConfidenceRedMod}

Pool: top ${appConfig.whaleConfidencePoolSize} wallets · min ${appConfig.whaleConfidenceMinPoolOps} ops
Window: ${(appConfig.whaleConfidenceWindowMs / 3600_000).toFixed(1)}h rolling
Poll: ${(appConfig.whaleConfidencePollMs / 1000).toFixed(0)}s
Min ops for signal: ${appConfig.whaleConfidenceMinOps}

Mode: *${appConfig.whaleConfidenceShadow ? 'SHADOW (logged only)' : 'LIVE (applied to danger)'}*
${appConfig.whaleConfidenceDisabled ? '\n⚠ Disabled via env (WHALE_CONFIDENCE_DISABLED=1)' : ''}

Set via env vars in \`.env\` + restart:
  \`WHALE_CONFIDENCE_SHADOW=false\` to go live`);
            return;
          }
          if (sub2 === 'outcomes') {
            const outcomes = (state?.whaleRecent ?? []) as Array<{
              wallet: string; corp: string; mode: string; success: boolean; detectedAt: number;
            }>;
            if (outcomes.length === 0) {
              await this.sendDm(chatId, '_No whale outcomes detected yet — tracker may still be warming up._');
              return;
            }
            const lines = outcomes.slice(0, 20).map(o => {
              const ago = Math.round((Date.now() - o.detectedAt) / 60_000);
              const mark = o.success ? '✓' : '✗';
              return `  ${mark} \`${o.wallet.slice(0,10)}..\` ${o.mode} _(${ago}m ago)_`;
            }).join('\n');
            await this.sendDm(chatId,
`*🐋 Last ${outcomes.length} whale outcomes*

${lines}`);
            return;
          }
          // Default: full panel
          if (!wc) {
            await this.sendDm(chatId, '_Whale tracker not running or no data yet (warm-up takes ~15min)._');
            return;
          }
          const signalEmoji: Record<string, string> = {
            green: '🟢', yellow: '🟡', orange: '🟠', red: '🔴',
          };
          const emoji = signalEmoji[wc.signal] ?? '⚪';
          const fmtSr = (n: number) => `${(n * 100).toFixed(1)}%`;
          const wallets = (wc.perWallet ?? []) as Array<{
            wallet: string; ops2h: number; sr2h: number; currentActiveOps: number;
          }>;
          const walletLines = wallets.map((w, i) => {
            const bar = (() => {
              const n = Math.max(0, Math.min(8, Math.round(w.sr2h * 8)));
              return '█'.repeat(n) + '░'.repeat(8 - n);
            })();
            const status = w.sr2h >= 0.65 ? '🟢' : w.sr2h >= 0.50 ? '🟡' : w.sr2h > 0 ? '🔴' : '⚪';
            return `  #${i+1} \`${w.wallet.slice(0,10)}..\` ${fmtSr(w.sr2h)} ${bar} ${status} (${w.ops2h} ops, ${w.currentActiveOps} active)`;
          }).join('\n');
          const recent = (state?.whaleRecent ?? []).slice(0, 10) as Array<{ success: boolean }>;
          const ticker = recent.length > 0
            ? recent.map(o => o.success ? '✓' : '✗').reverse().join('')
            : '—';
          const recentSr = recent.length > 0
            ? `${recent.filter(o => o.success).length}/${recent.length}`
            : '—';
          const shadowTag = wc.shadow ? '  _(SHADOW)_' : '';
          const ag = wc.aggregate;
          await this.sendDm(chatId,
`*🐋 Whale Confidence* ${emoji} *${wc.signal.toUpperCase()}* · D${wc.dangerModifier >= 0 ? '+' : ''}${wc.dangerModifier}${shadowTag}

*Aggregate:* ${fmtSr(ag.sr2h)} SR (${ag.totalSuccesses2h}/${ag.totalOps2h} ops, last 2h)
*Active now:* ${ag.activeDrugOps} Drug · ${ag.activeArmsOps} Arms · ${ag.activeExtOps} Ext

*Per-wallet (2h):*
${walletLines || '  _(pool empty)_'}

*Recent (last 10):*
  ${ticker}  (${recentSr})

Tracked: ${wc.trackedWallets} wallets · ${wc.trackedCorps} corps

\`/bot whales outcomes\` — last 20 outcomes
\`/bot whales config\`   — thresholds & mode`);
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

  /**
   * Main menu = the rich status view. Two-button "Status" surfaces both at
   * the top (refresh / show again) and a normal main-menu nav below.
   */
  private renderMainMenu(): { text: string; rows: IKBtn[][] } {
    return this.renderStatusMenu();
  }

  /**
   * Rich sectioned status. Sources:
   *   - corpBot.getStatus()                  fleet/preset/balances/breaker
   *   - corpBot.getGraduatedState()          live graduated target (with effective danger)
   *   - corpBot.getNhPenalty()               NH cascade penalty (faded)
   *   - corpBot.getEffectiveDanger()         danger + NH penalty
   *   - getState() (decorated)               cycle pool / hedge / regime
   *   - computeEfficiency(storage, 24h)      P&L / SR / D-per-INF
   *   - storage.getOperatorBurnVsClaim(1d)   24h claim sum
   *
   * Keyboard is CONTEXTUAL — adapts to graduated active / breaker tripped /
   * paused / hedge active. See buildContextualRows().
   */
  private renderStatusMenu(): { text: string; rows: IKBtn[][] } {
    const cb = this.cfg.corpBot;
    if (!cb) {
      return { text: '*🤖 Offshore Bot*\n\n_Trading bot disabled (no MAIN_KEY)._', rows: [] };
    }
    const s = cb.getStatus();
    const state: any = this.cfg.getState?.() ?? {};

    const fmt = (n: number, dec = 0) =>
      n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    const fmtUsd = (n: number) => `$${fmt(Math.round(n))}`;
    const fmtSigned = (n: number) => (n >= 0 ? '+' : '') + fmtUsd(n);

    // ── P&L (24h) ────────────────────────────────────────────────
    let pnlBlock = '_(P&L unavailable)_';
    let srPct: number | null = null;
    let dPerInf: number | null = null;
    let infBurned24h = 0;
    let claimSum24h = 0;
    try {
      const { computeEfficiency } = require('./efficiency') as typeof import('./efficiency');
      const eff = computeEfficiency(this.cfg.storage, { windowHours: 24 });
      const bvc = this.cfg.storage.getOperatorBurnVsClaim({
        operator: appConfig.walletAddress,
        days: 1,
      });
      claimSum24h = bvc.cycles.reduce((acc: number, c: any) => acc + c.claim_usdm, 0);
      infBurned24h = eff.overall.inf_spent;
      const net = claimSum24h - infBurned24h;
      srPct = eff.overall.sr * 100;
      dPerInf = eff.overall.dirty_per_inf;
      const dpiStr = Number.isFinite(dPerInf as number)
        ? (dPerInf as number).toFixed(2)
        : '∞';
      pnlBlock =
`*💰 P&L (24h):*
  Claims: ${fmtUsd(claimSum24h)} · Burned: ${fmt(infBurned24h)} INF
  Net: ${fmtSigned(net)} USDm
  SR: ${srPct.toFixed(1)}% · D/INF: ${dpiStr}`;
    } catch (err: any) {
      logger.warn({ err: err.message }, '[TgBot] status P&L block failed');
    }

    // ── FLEET ────────────────────────────────────────────────
    const presetSourceTag = (label: string) => {
      if (label.startsWith('manual:'))   return '🔒 manual';
      if (label.startsWith('auto:'))     return '📅 schedule';
      if (label.startsWith('breaker:'))  return '🚨 breaker';
      if (label.startsWith('danger:'))   return '⚠ danger override';
      if (label.startsWith('fallback:')) return '⤵ fallback';
      return '?';
    };
    const grad = cb.getGraduatedState(cb.getEffectiveDanger());
    const activeCorps = s.perCorp.filter(c => c.auto).length;
    const fleetCount = grad.enabled && grad.currentTarget < grad.totalCorps
      ? `${grad.currentTarget}/${grad.totalCorps} (graduated: ${grad.currentLevel})`
      : `${activeCorps}/${s.totalCorps}`;
    let fleetBlock =
`*🚢 FLEET:*
  Active: ${fleetCount} corps · \`${s.activePresetName}\` ${presetSourceTag(s.activePresetName)}`;
    if (grad.enabled && grad.pausedCorps.length > 0) {
      fleetBlock += `\n  Paused (graduated): ${grad.pausedCorps.length} corp${grad.pausedCorps.length > 1 ? 's' : ''}`;
    }

    // ── DANGER ────────────────────────────────────────────────
    const nhPen = cb.getNhPenalty();
    const effDanger = cb.getEffectiveDanger();
    const rawDanger = s.lastDanger ?? 0;
    const nhStr = nhPen > 0 ? ` · NH +${nhPen}` : '';
    let dangerStr = `${effDanger}/100`;
    if (nhPen > 0) dangerStr = `${rawDanger}→${effDanger}/100${nhStr}`;
    const dangerBlock =
`*🌊 DANGER:* ${dangerStr} (band ${s.dangerLow}-${s.dangerHigh}, panic ≥${s.panicThreshold})`;

    // ── OPS / SCHEDULE ────────────────────────────────────────
    const regime = cb.getCurrentRegime();
    const scheduleLine = s.scheduleEnabled
      ? `${String(s.hktHour).padStart(2,'0')}h HKT → \`${s.schedulePresetThisHour ?? '—'}\` (${regime})`
      : `OFF — fallback paused`;
    const opsBlock = `*⏱ OPS:* ${scheduleLine}`;

    // ── CYCLE ────────────────────────────────────────────────
    let cycleBlock = '';
    const cyc = state?.loadouts?.cycle;
    if (cyc) {
      const secs = cyc.secondsRemaining ?? 0;
      const hrs = Math.floor(secs / 3600);
      const mins = Math.floor((secs % 3600) / 60);
      const remaining = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
      const pool = cyc.netPool ?? cyc.pool ?? 0;
      cycleBlock = `*🏦 CYCLE:* ends in ${remaining} · pool ${fmtUsd(pool)}`;
    }

    // ── WALLET ────────────────────────────────────────────────
    const balRate = (r: number | null | undefined, suffix: string) =>
      r == null ? '' : ` _(${r >= 0 ? '+' : ''}${r.toFixed(1)}${suffix})_`;
    let walletBlock = '_(wallet warming up)_';
    if (s.balances) {
      walletBlock =
`*💵 WALLET:*
  INF: \`${fmt(s.balances.inf)}\`${balRate(s.balances.infPerHr, '/hr')}
  DIRTY: \`${fmt(s.balances.dirty)}\` · USDM: \`${fmt(s.balances.usdm)}\``;
    }

    // ── HEDGE / BREAKER alerts (top-of-strip) ─────────────────
    const banners: string[] = [];
    if (s.circuitBreaker.tripped) {
      const m = Math.floor(s.circuitBreaker.cooldownSecondsRemaining / 60);
      banners.push(`🚨 BREAKER TRIPPED — clears in ${m}m`);
    }
    const hedge = state?.hedge;
    if (hedge?.mode === 'live' && hedge?.activeHedge) {
      const ah = hedge.activeHedge;
      banners.push(`🛡 HEDGE active — short $${ah.notional?.toFixed(0)} · TP $${ah.takeProfitPrice?.toFixed(2)}`);
    } else if (hedge?.enabled && hedge?.mode === 'shadow' && (hedge?.stats?.totalShadowOpens ?? 0) > 0) {
      const st = hedge.stats;
      banners.push(`🛡 Hedge SHADOW: ${st.totalShadowOpens} opens, would-profit ${st.wouldProfit}/${st.totalShadowCloses}`);
    }

    // ── COMMENTARY ────────────────────────────────────────────
    const commentary = this.buildStatusCommentary({
      paused: s.paused || !s.running,
      activePreset: s.activePresetName,
      effDanger,
      nhPen,
      grad,
      srPct,
      dPerInf,
      claimSum24h,
      infBurned24h,
      cycleSecsRemaining: cyc?.secondsRemaining ?? null,
      regime,
    });

    // ── WHALE CONFIDENCE ─────────────────────────────────────
    let whaleBlock = '';
    const wc = state?.whaleConfidence;
    if (wc) {
      const signalEmoji: Record<string, string> = {
        green: '🟢', yellow: '🟡', orange: '🟠', red: '🔴',
      };
      const emoji = signalEmoji[wc.signal] ?? '⚪';
      const shadowTag = wc.shadow ? ' _(shadow)_' : '';
      const ag = wc.aggregate;
      if (wc.hasSignal) {
        const modStr = wc.dangerModifier === 0
          ? ''
          : ` · D${wc.dangerModifier > 0 ? '+' : ''}${wc.dangerModifier}`;
        whaleBlock =
`*🐋 WHALES* ${emoji} ${(ag.sr2h * 100).toFixed(0)}% SR (${ag.totalOps2h} ops 2h)${modStr}${shadowTag}
  Active: ${ag.activeDrugOps} Drug · ${ag.activeArmsOps} Arms`;
      } else {
        whaleBlock = `*🐋 WHALES* ⚪ warming up (${ag.totalOps2h}/${appConfig.whaleConfidenceMinOps} ops)${shadowTag}`;
      }
    }

    const sections = [pnlBlock, fleetBlock, dangerBlock, opsBlock, cycleBlock, whaleBlock, walletBlock]
      .filter(Boolean)
      .join('\n');
    const bannerBlock = banners.length > 0 ? banners.map(b => `_${b}_`).join('\n') + '\n\n' : '';
    const text =
`*🤖 Offshore Bot*

${bannerBlock}${sections}${commentary ? `\n\n_💬 ${commentary}_` : ''}`;

    return { text, rows: this.buildContextualRows(s, grad, hedge) };
  }

  /**
   * Contextual keyboard. Surfaces the action the operator most likely wants
   * given current state — not a static 5-row grid.
   *
   *   Stopped / Off     → ▶ Start Ops + base nav
   *   Breaker tripped   → 🚨 Clear Breaker (prominent)
   *   Graduated active  → 📈 Override Graduated row
   *   Hedge active/shadow → 🛡 Hedge details
   *   Otherwise         → Claim / Pause / standard nav
   */
  private buildContextualRows(
    s: ReturnType<NonNullable<CorpBot['getStatus']>>,
    grad: ReturnType<NonNullable<CorpBot['getGraduatedState']>>,
    hedge: any,
  ): IKBtn[][] {
    const rows: IKBtn[][] = [];
    const isStopped = !s.running || s.paused;
    const breakerTripped = s.circuitBreaker.tripped;

    // Priority action row
    if (breakerTripped) {
      rows.push([{ text: '🚨 Clear Breaker', data: 'breaker:clear' }]);
    } else if (isStopped) {
      rows.push([{ text: '▶️ Start Ops', data: 'action:resume' }, { text: '🔄 Refresh', data: 'menu:status' }]);
    }

    // Graduated override (only show if it actually paused corps)
    if (grad.enabled && grad.pausedCorps.length > 0) {
      rows.push([{ text: `📈 Resume full fleet (${grad.totalCorps})`, data: 'graduated:off' }]);
    }

    // Hedge surface (any time hedge is enabled)
    if (hedge?.enabled) {
      rows.push([{ text: `🛡 Hedge (${hedge.mode})`, data: 'menu:hedge' }]);
    }

    // Standard nav
    rows.push([{ text: '🎯 Presets', data: 'menu:presets' }, { text: '📅 Schedule', data: 'menu:schedule' }]);
    rows.push([{ text: '💰 Wallet',  data: 'menu:wallet' },  { text: '⚙️ Config',  data: 'menu:config' }]);

    // Footer: claim + pause (replace pause with resume when paused)
    if (!isStopped && !breakerTripped) {
      rows.push([
        { text: '💸 Claim Now', data: 'action:claim' },
        { text: '⏸ Pause',     data: 'action:pause' },
      ]);
    }
    rows.push([{ text: '📋 Logs', data: 'menu:logs' }, { text: '🔄 Refresh', data: 'menu:status' }]);

    return rows;
  }

  /**
   * One-line interpretive commentary on current state. Heuristics ranked
   * by priority — only surface the most relevant. Conservative copy: a
   * bad sentence is worse than no sentence.
   */
  private buildStatusCommentary(ctx: {
    paused: boolean;
    activePreset: string;
    effDanger: number;
    nhPen: number;
    grad: ReturnType<NonNullable<CorpBot['getGraduatedState']>>;
    srPct: number | null;
    dPerInf: number | null;
    claimSum24h: number;
    infBurned24h: number;
    cycleSecsRemaining: number | null;
    regime: 'weekday' | 'weekend';
  }): string | null {
    // Highest priority: state-of-the-bot signals
    if (ctx.paused) return 'Bot is paused. No new ops will start until you resume.';
    if (ctx.activePreset.startsWith('breaker:')) {
      return 'Circuit breaker tripped — multiple liquidations in the last 5m. Cooldown in effect.';
    }
    if (ctx.activePreset.startsWith('danger:')) {
      return `Danger override active (${ctx.effDanger}/100). Bot will resume when conditions calm.`;
    }
    if (ctx.grad.enabled && ctx.grad.pausedCorps.length > 0) {
      return `Graduated scaling reducing fleet to ${ctx.grad.currentTarget}/${ctx.grad.totalCorps} — ${ctx.grad.currentLevel}.`;
    }
    if (ctx.nhPen > 0) {
      return `Network cascade detected — danger penalty +${ctx.nhPen}. Fading over the next ~90min.`;
    }
    if (ctx.cycleSecsRemaining != null && ctx.cycleSecsRemaining < 900 && ctx.cycleSecsRemaining > 0) {
      const m = Math.ceil(ctx.cycleSecsRemaining / 60);
      return `Cycle ends in ${m}m — claim window opens after.`;
    }
    // Performance heuristics
    if (ctx.srPct != null && ctx.srPct < 50 && ctx.infBurned24h > 30) {
      return `24h SR ${ctx.srPct.toFixed(0)}% is below network median. Worth checking strategy attribution.`;
    }
    if (ctx.srPct != null && ctx.srPct >= 70 && ctx.dPerInf != null && Number.isFinite(ctx.dPerInf) && ctx.dPerInf > 20) {
      return `Strong session: ${ctx.srPct.toFixed(0)}% SR · ${(ctx.dPerInf as number).toFixed(1)} D/INF. Reinvest claims to compound.`;
    }
    if (ctx.regime === 'weekend' && ctx.effDanger < 40) {
      return 'Weekend regime · calm danger. Drug ops are typically best here.';
    }
    return null;
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

  private renderHedgeMenu(): { text: string; rows: IKBtn[][] } {
    const hedge = this.cfg.hedgeBot;
    if (!hedge) {
      return {
        text: '*🛡 Hedge*\n\n_Hedge bot not running on this deployment._',
        rows: [[{ text: '← Back', data: 'menu:status' }]],
      };
    }
    const st = hedge.getState();
    const last = st.lastSizing;
    const lines: string[] = [
      `*🛡 Hedge*`,
      ``,
      `Enabled: *${st.enabled ? 'YES' : 'no'}*  ·  Mode: *${st.mode.toUpperCase()}*${st.disabled ? '  ·  ⚠ disabled' : ''}`,
      `Policy: \`${hedge.getActivationPolicy()}\``,
    ];
    if (st.activeHedge) {
      const a = st.activeHedge;
      lines.push('');
      lines.push(`*Active${st.mode === 'shadow' ? ' (shadow)' : ''}*:`);
      lines.push(`  corps: ${a.corpsHedged.length} · notional \`$${a.notional.toFixed(0)}\``);
      lines.push(`  margin: \`$${a.margin.toFixed(0)}\` · TP \`$${a.takeProfitPrice.toFixed(2)}\``);
    } else {
      lines.push('');
      lines.push('  _(no active hedge)_');
    }
    if (st.stats.totalShadowOpens > 0) {
      lines.push('');
      lines.push(`*Shadow stats:* ${st.stats.totalShadowOpens} opens · ${st.stats.totalShadowCloses} closes`);
      lines.push(`  would-profit: ${st.stats.wouldProfit}/${st.stats.totalShadowCloses}`);
      lines.push(`  net P&L: $${st.stats.totalShadowPnl.toFixed(0)}`);
    }
    if (last) {
      lines.push('');
      lines.push(`*Last sizing:* ETH $${last.ethPrice.toFixed(2)} · TP $${last.takeProfitPrice.toFixed(2)}`);
    }
    return {
      text: lines.join('\n'),
      rows: [[{ text: '🔄 Refresh', data: 'menu:hedge' }, { text: '← Back', data: 'menu:status' }]],
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
          case 'hedge':    view = this.renderHedgeMenu(); break;
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
        // Refresh main status (not the deep breaker menu) since the
        // breaker:clear button now appears on the top-level status.
        const view = this.renderStatusMenu();
        await this.editKb(chatId, messageId, view.text, view.rows);
        return;
      }

      if (type === 'graduated' && action === 'off') {
        cb.setGraduatedEnabled(false);
        await this.ackCallback(cq.id, 'Graduated scaling OFF');
        const view = this.renderStatusMenu();
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
