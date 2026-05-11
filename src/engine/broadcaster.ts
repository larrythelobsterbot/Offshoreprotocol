// ============================================================
// Channel broadcaster.
//
// Watches the engine's DashboardState transitions and posts to a
// public Telegram channel when crossings occur:
//
//   - Danger band entry/exit (composite danger score crossing 60/40)
//   - Cascade risk transition (LOW→ELEVATED→HIGH→CRITICAL)
//   - Volatility regime change (low→medium→high)
//   - "Calm window" — best EV/INF op's calibrated P(fail) drops
//     significantly below baseline
//   - Live $DIRTY price moves >5% from the rolling baseline
//
// Each alert type has a per-type cooldown to prevent spam. The
// overall design rule: a subscriber should expect roughly 5-15
// messages per active day, never an alert flood.
// ============================================================

import { logger } from '../logger';
import type { DashboardState } from '../types';
import type { TgBot } from './tgbot';

interface BroadcasterConfig {
  bot: TgBot;
  channelHandle: string; // e.g. 'offshorecasinochannel' (no @)
  refLink?: string;      // appended to "soft" alerts as a CTA reminder
}

interface AlertCooldown {
  cooldownMs: number;
  lastFiredAt: number;
}

export class Broadcaster {
  private cfg: BroadcasterConfig;
  private cooldowns: Record<string, AlertCooldown> = {
    danger_high:    { cooldownMs: 60 * 60_000, lastFiredAt: 0 }, // 1h
    danger_low:     { cooldownMs: 60 * 60_000, lastFiredAt: 0 },
    cascade:        { cooldownMs: 30 * 60_000, lastFiredAt: 0 },
    regime_change:  { cooldownMs: 30 * 60_000, lastFiredAt: 0 },
    calm_window:    { cooldownMs: 90 * 60_000, lastFiredAt: 0 }, // 90m so it doesn't flap
    price_swing:    { cooldownMs: 60 * 60_000, lastFiredAt: 0 },
    // Danger-v2 leading-indicator alerts (transition-edge)
    nh_cascade:     { cooldownMs: 15 * 60_000, lastFiredAt: 0 }, // 15m — cascades fade fast
    eth_velocity:   { cooldownMs: 15 * 60_000, lastFiredAt: 0 },
  };

  // Memoized last-seen values so we can detect transitions
  private lastDangerScore: number | null = null;
  private lastCascadeRisk: string | null = null;
  private lastRegime: string | null = null;
  private lastBestOpProb: number | null = null;
  private priceBaseline: number | null = null;
  private priceBaselineTs: number = 0;
  // Danger-v2 transition state
  private lastNhTrip: boolean = false;
  private lastEvTrip: boolean = false;

  constructor(cfg: BroadcasterConfig) {
    this.cfg = cfg;
  }

  /**
   * Called from the same broadcast loop that fans state to WS clients.
   * Idempotent: alerts only fire on transitions, never every tick.
   */
  observe(state: DashboardState) {
    if (!this.cfg.channelHandle) return;
    try {
      this.checkDanger(state);
      this.checkCascade(state);
      this.checkRegime(state);
      this.checkCalmWindow(state);
      this.checkPriceSwing(state);
      this.checkNetworkHealth(state);
      this.checkEthVelocity(state);
    } catch (err: any) {
      logger.warn({ err: err.message }, '[Broadcaster] observe threw');
    }
  }

  /**
   * Post the daily digest. Caller schedules this once per day at a
   * fixed UTC hour (e.g. 01:00 = 09:00 HKT) — not transition-driven.
   */
  async postDailyDigest(text: string) {
    if (!this.cfg.channelHandle) return;
    await this.cfg.bot.sendChannel(this.cfg.channelHandle, text);
  }

  /**
   * Compose the daily digest body from current state. Pulls:
   *   - ETH price + 24h move
   *   - Network success rate over the last 24h
   *   - Best/worst HKT hours per op type (from schedule-evidence rolling window)
   *   - Active player count
   *   - Vault USDM payout pool
   *   - Today's recommended op-mix outlook
   *
   * Returns ready-to-post Markdown text.
   *
   * Privacy invariants: NO operator-specific data. Only network aggregates,
   * public on-chain reads, and ETH market data. No corp addresses, no
   * operator wallet, no personal P&L.
   */
  composeDailyDigest(input: {
    state: DashboardState;
    rolling7d: import('../feeds/schedule-evidence').RollingStats | null;
    vaultPoolUsdm?: number | null;
  }): string {
    const { state: s, rolling7d, vaultPoolUsdm } = input;

    const eth = s.ethPrice;
    const ethStart = s.ethPriceStart;
    const ethDelta = (eth != null && ethStart != null && ethStart > 0)
      ? ((eth - ethStart) / ethStart) * 100 : null;

    const tok: any = (s as any).tokenomics ?? {};
    const activePlayers = tok.activePlayers ?? '—';
    const dirtyDelta24 = tok.tokens?.DIRTY?.pctChange24h;

    // Network 24h headline from schedule-evidence (or fall back to scores)
    const globalSR = rolling7d?.globalSR != null
      ? (rolling7d.globalSR * 100).toFixed(1) + '%'
      : '—';

    // Compose best/worst lines (just top 3 per op type)
    const fmtHrs = (hrs: number[]) =>
      hrs.slice(0, 3).map(h => String(h).padStart(2, '0') + 'h').join(' · ') || '—';
    const drugBest = rolling7d ? fmtHrs(rolling7d.bestHours.drug)  : '—';
    const drugWorst= rolling7d ? fmtHrs(rolling7d.worstHours.drug) : '—';
    const armsBest = rolling7d ? fmtHrs(rolling7d.bestHours.arms)  : '—';
    const armsWorst= rolling7d ? fmtHrs(rolling7d.worstHours.arms) : '—';

    // Current HKT hour (UTC + 8)
    const hktHour = (new Date().getUTCHours() + 8) % 24;

    // Live danger
    const danger = s.scores?.dangerScore ?? null;
    const dangerEmoji = danger == null ? '⚪' : danger >= 60 ? '🔴' : danger >= 40 ? '🟡' : '🟢';

    const lines: string[] = [];
    lines.push(`📊 *Offshore Protocol — Daily Recap*`);
    lines.push(`${new Date().toUTCString().slice(0, 16)} UTC · 09:00 HKT`);
    lines.push('');
    if (eth != null) {
      const deltaStr = ethDelta != null ? ` (${ethDelta >= 0 ? '+' : ''}${ethDelta.toFixed(2)}% session)` : '';
      lines.push(`🔷 *ETH* $${eth.toFixed(2)}${deltaStr}`);
    }
    lines.push(`${dangerEmoji} *Danger* ${danger ?? '—'}/100  ·  *Network SR (7d)* ${globalSR}`);
    if (vaultPoolUsdm != null) {
      const k = vaultPoolUsdm / 1000;
      lines.push(`💰 *Vault pool* $${k >= 1000 ? (k/1000).toFixed(2) + 'M' : k.toFixed(1) + 'K'} USDM`);
    }
    lines.push(`👥 *Active players* ${activePlayers}` +
      (dirtyDelta24 != null ? `  ·  *DIRTY 24h* ${dirtyDelta24 >= 0 ? '+' : ''}${dirtyDelta24.toFixed(1)}%` : ''));
    lines.push('');
    lines.push(`*Best HKT hours (last 7d evidence)*`);
    lines.push(`  Drug: ${drugBest}`);
    lines.push(`  Arms: ${armsBest}`);
    lines.push('');
    lines.push(`*Avoid these hours*`);
    lines.push(`  Drug: ${drugWorst}`);
    lines.push(`  Arms: ${armsWorst}`);
    lines.push('');
    lines.push(`Right now (${String(hktHour).padStart(2, '0')}h HKT): see live tracker`);
    lines.push('');
    lines.push(`▶ ${this.publicLink()}`);
    lines.push(`⚠ Read-only · unaffiliated · not financial advice`);
    return lines.join('\n');
  }

  /**
   * Operator-only efficiency summary DM. Composed separately from the
   * public channel digest because it carries the operator's personal
   * P&L (DIRTY earned, INF lost, success rate) — which the channel
   * digest is explicitly forbidden from publishing (see
   * `composeDailyDigest` privacy invariants).
   *
   * Inputs:
   *   eff24h  — last-24h efficiency snapshot
   *   eff7d   — last-7d efficiency snapshot (used for trend comparison)
   *
   * Both come from `computeEfficiency(storage, { windowHours: N })`.
   *
   * Refund-on-success handling: when the 24h window has zero failures
   * (every op refunded its INF), `eff24h.overall.dirty_per_inf` is
   * `Infinity`. We render it as "∞ (no losses)" and skip the trend
   * arrow since percentage delta against ∞ is meaningless.
   *
   * Returns Markdown ready for `bot.sendDm(..., { parseMode: 'Markdown' })`.
   */
  composeOperatorEfficiencyDm(input: {
    eff24h: import('./efficiency').EfficiencySnapshot;
    eff7d: import('./efficiency').EfficiencySnapshot;
  }): string {
    const o24 = input.eff24h.overall;
    const o7  = input.eff7d.overall;
    const dpi = o24.dirty_per_inf;
    const dpi7 = o7.dirty_per_inf;

    // Trend arrow: only meaningful when both ends are finite + 7d had losses.
    let trendStr = '';
    if (Number.isFinite(dpi) && Number.isFinite(dpi7) && dpi7 > 0) {
      const pct = ((dpi - dpi7) / dpi7) * 100;
      const arrow = Math.abs(pct) < 0.5 ? '·' : pct > 0 ? '▲' : '▼';
      const sign = pct >= 0 ? '+' : '';
      trendStr = `  ${arrow} ${sign}${pct.toFixed(1)}% vs 7d`;
    } else if (!Number.isFinite(dpi) && Number.isFinite(dpi7)) {
      trendStr = `  ▲ ∞ vs 7d`;
    } else if (Number.isFinite(dpi) && !Number.isFinite(dpi7)) {
      trendStr = `  ▼ vs 7d ∞`;
    }

    // Drug-vs-Arms breakdown when both ops actually ran.
    const byType = input.eff24h.by_op_type ?? [];
    const drug = byType.find(t => t.op_type === 'drug');
    const arms = byType.find(t => t.op_type === 'arms');

    const fmtDpi = (v: number) => Number.isFinite(v) ? v.toFixed(2) : '∞';
    const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;

    const lines: string[] = [];
    lines.push(`📊 *24h INF Efficiency*`);
    lines.push('');
    if (o24.ops === 0) {
      lines.push(`_No ops in the last 24h._`);
      lines.push('');
      lines.push(`7d: ${fmtDpi(dpi7)} D/INF · ${fmtPct(o7.sr)} SR · ${o7.ops} ops`);
      return lines.join('\n');
    }
    lines.push(`DIRTY/INF lost: *${fmtDpi(dpi)}*${trendStr}`);
    lines.push(`SR: *${fmtPct(o24.sr)}*  ·  Ops: *${o24.ops}*  ·  ${o24.wins}W / ${o24.ops - o24.wins}L`);
    lines.push(`DIRTY earned: *${Math.round(o24.dirty_earned).toLocaleString()}*  ·  INF lost: *${o24.inf_spent.toFixed(0)}*`);
    if (o24.avg_partial_payout > 0) {
      lines.push(`Avg partial on fail: *${o24.avg_partial_payout.toFixed(1)} DIRTY*`);
    }
    if (drug && arms && drug.ops > 0 && arms.ops > 0) {
      lines.push('');
      lines.push(`Drug ${drug.ops}× → ${fmtDpi(drug.dirty_per_inf)} D/INF · ${fmtPct(drug.sr)} SR`);
      lines.push(`Arms ${arms.ops}× → ${fmtDpi(arms.dirty_per_inf)} D/INF · ${fmtPct(arms.sr)} SR`);
    } else if (drug && drug.ops > 0) {
      lines.push('');
      lines.push(`Drug ${drug.ops}× → ${fmtDpi(drug.dirty_per_inf)} D/INF · ${fmtPct(drug.sr)} SR`);
    } else if (arms && arms.ops > 0) {
      lines.push('');
      lines.push(`Arms ${arms.ops}× → ${fmtDpi(arms.dirty_per_inf)} D/INF · ${fmtPct(arms.sr)} SR`);
    }
    lines.push('');
    lines.push(`_(slot-by-slot alerts follow separately for any underperforming HKT hour)_`);
    return lines.join('\n');
  }

  private canFire(key: keyof typeof this.cooldowns): boolean {
    const c = this.cooldowns[key];
    const now = Date.now();
    if (now - c.lastFiredAt < c.cooldownMs) return false;
    c.lastFiredAt = now;
    return true;
  }

  private async fire(text: string) {
    await this.cfg.bot.sendChannel(this.cfg.channelHandle, text);
  }

  // ---- Transition detectors ----

  private checkDanger(s: DashboardState) {
    const score = s.scores?.dangerScore;
    if (typeof score !== 'number') return;
    const prev = this.lastDangerScore;
    this.lastDangerScore = score;
    if (prev === null) return; // first observation, just record

    // High alert: cross from <60 to >=60
    if (prev < 60 && score >= 60 && this.canFire('danger_high')) {
      void this.fire(
`⚠️ *Danger HIGH* (${score}/100)

Composite risk score crossed 60. Calibrated P(fail) elevated across all ops.
Pause Extortion (binary fail). Drug stays +EV but margins thinner.

Live: ${this.dashboardLink()}`);
    }
    // All-clear: cross from >=60 down through 40
    else if (prev >= 60 && score < 40 && this.canFire('danger_low')) {
      void this.fire(
`✅ *Danger LOW* (${score}/100)

Composite risk back to baseline. Drug + Arms in normal +EV territory.

Live: ${this.dashboardLink()}`);
    }
  }

  private checkCascade(s: DashboardState) {
    const risk = s.scores?.cascadeRisk;
    if (!risk) return;
    const prev = this.lastCascadeRisk;
    this.lastCascadeRisk = risk;
    if (prev === null || prev === risk) return;

    if ((risk === 'HIGH' || risk === 'CRITICAL') && this.canFire('cascade')) {
      void this.fire(
`🔴 *Liquidation cascade: ${risk}*

ETH liquidation velocity spiking. All ops at heightened risk for the next 5–15 min.
Pause and reassess after the spike clears.

Live: ${this.dashboardLink()}`);
    }
  }

  private checkRegime(s: DashboardState) {
    const regime = s.volatility?.regime;
    if (!regime || regime === 'unknown') return;
    const prev = this.lastRegime;
    this.lastRegime = regime;
    if (prev === null || prev === regime) return;

    if ((regime === 'high' || regime === 'medium') && prev === 'low' && this.canFire('regime_change')) {
      void this.fire(
`📈 *Volatility regime: ${regime.toUpperCase()}*

ETH realized vol shifted up. P(fail) elevated; review op selection.

Live: ${this.dashboardLink()}`);
    } else if (regime === 'low' && (prev === 'medium' || prev === 'high') && this.canFire('regime_change')) {
      void this.fire(
`📉 *Volatility regime: LOW*

Calm window — best EV/INF window of the day if it sustains.

Live: ${this.dashboardLink()}`);
    }
  }

  private checkCalmWindow(s: DashboardState) {
    // Soft alert: best-op calibrated P(fail) drops well below baseline
    const econ = s.economics;
    if (!econ?.drug) return;
    const drugP = econ.drug.probFail;
    const prev = this.lastBestOpProb;
    this.lastBestOpProb = drugP;
    if (prev === null) return;

    // Drug baseline is ~40%. Fire when calibrated drops below 28% from above.
    if (prev >= 0.30 && drugP < 0.28 && this.canFire('calm_window')) {
      void this.fire(
`🟢 *Drug Deal optimal window*

Calibrated P(fail) dropped to ${(drugP * 100).toFixed(1)}% (baseline ~40%).
EV per op: $${econ.drug.evDirty.toFixed(0)} $DIRTY · $/INF: ${Number.isFinite(econ.drug.dirtyPerInf) ? econ.drug.dirtyPerInf.toFixed(2) : '∞ (no expected losses)'}

Live: ${this.dashboardLink()}`);
    }
  }

  private checkPriceSwing(s: DashboardState) {
    const amm = s.ammRate;
    if (!amm?.ok || !amm.dirtyPriceUsdm) return;
    const px = amm.dirtyPriceUsdm;
    const now = Date.now();
    if (this.priceBaseline === null) {
      this.priceBaseline = px;
      this.priceBaselineTs = now;
      return;
    }
    // Reset baseline if it's stale (>4h)
    if (now - this.priceBaselineTs > 4 * 3600_000) {
      this.priceBaseline = px;
      this.priceBaselineTs = now;
      return;
    }
    const pctChange = (px - this.priceBaseline) / this.priceBaseline;
    if (Math.abs(pctChange) >= 0.05 && this.canFire('price_swing')) {
      const dir = pctChange > 0 ? '📈 up' : '📉 down';
      void this.fire(
`${dir} *$DIRTY ${(pctChange * 100).toFixed(1)}%* over ~${Math.round((now - this.priceBaselineTs) / 60_000)} min

Now: $${px.toFixed(5)} sell-side
Drug breakeven: $0.0625 · Arms breakeven: $0.069 · Extortion breakeven: $0.151

Live: ${this.dashboardLink()}`);
      this.priceBaseline = px;
      this.priceBaselineTs = now;
    }
  }

  // Danger-v2 transition: NetworkHealth crosses into "would pause" state.
  // Posts even when the signal is in shadow mode — the channel publishes
  // the WARNING regardless; only bot behavior is gated by shadow mode.
  private checkNetworkHealth(s: DashboardState) {
    const nh = (s as any).networkHealth as
      | (import('../feeds/network-health').NetworkHealthSnapshot | null)
      | undefined;
    if (!nh) return;
    const tripped = nh.wouldPause;
    const prev = this.lastNhTrip;
    this.lastNhTrip = tripped;
    // Only act on rising edge (entering trip state)
    if (tripped && !prev && this.canFire('nh_cascade')) {
      const tag = nh.wouldPauseOpType
        ? `${nh.wouldPauseOpType.toUpperCase()} CASCADE`
        : 'NETWORK CASCADE';
      void this.fire(
`🔴 *${tag}*

${nh.reason || 'liquidations spiking on-chain'}

5-min stats: ${nh.tc5min} successful, ${nh.tl5min} liquidated · network SR ${nh.networkSR5min == null ? '—' : (nh.networkSR5min * 100).toFixed(0) + '%'}
By op type (5m): drug ${nh.tlDrug5min} · arms ${nh.tlArms5min} · ext ${nh.tlExt5min}

Recommended: stand down on the affected op for the next 10–15 min.

Live tracker: ${this.publicLink()}`);
    }
  }

  // Danger-v2 transition: ETH velocity trip. Forward-looking — fires on
  // the first 1m or 5m sustained drop that crosses thresholds.
  private checkEthVelocity(s: DashboardState) {
    const ev = (s as any).ethVelocity as
      | (import('./eth-velocity-signal').EthVelocitySnapshot | null)
      | undefined;
    if (!ev || ev.bps1m == null) return;
    const tripped = ev.wouldPause;
    const prev = this.lastEvTrip;
    this.lastEvTrip = tripped;
    if (tripped && !prev && this.canFire('eth_velocity')) {
      const tag = ev.wouldPauseOpType
        ? `${ev.wouldPauseOpType.toUpperCase()} WINDOW`
        : 'ALL OPS';
      void this.fire(
`📉 *ETH dropping fast — ${tag} at risk*

${ev.reason || 'price velocity threshold crossed'}

1m: ${ev.bps1m >= 0 ? '+' : ''}${ev.bps1m.toFixed(0)} bps/min
5m: ${ev.bps5m! >= 0 ? '+' : ''}${ev.bps5m!.toFixed(0)} bps/min · accel ${ev.accel! >= 0 ? '+' : ''}${ev.accel!.toFixed(0)}

Recommended: hold new bootstraps for 60–120s.

Live tracker: ${this.publicLink()}`);
    }
  }

  /**
   * URL the OPERATOR's private dashboard. Used for danger/cascade/regime
   * alerts that link operators back to their dashboard.
   */
  private dashboardLink(): string {
    return process.env.DASHBOARD_URL || 'offshore.lekker.design';
  }

  /**
   * Public-facing URL surfaced in broadcast-channel posts. Drives ref
   * traffic to FlowDirty. Falls back to dashboard link if unset.
   */
  private publicLink(): string {
    return process.env.PUBLIC_TRACKER_URL || 'flowdirty.fun';
  }
}
