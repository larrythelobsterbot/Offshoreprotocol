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
  };

  // Memoized last-seen values so we can detect transitions
  private lastDangerScore: number | null = null;
  private lastCascadeRisk: string | null = null;
  private lastRegime: string | null = null;
  private lastBestOpProb: number | null = null;
  private priceBaseline: number | null = null;
  private priceBaselineTs: number = 0;

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
    } catch (err: any) {
      logger.warn({ err: err.message }, '[Broadcaster] observe threw');
    }
  }

  /**
   * Post the daily digest. Caller schedules this once per day at a
   * fixed UTC hour (e.g. 06:00) — not transition-driven.
   */
  async postDailyDigest(text: string) {
    if (!this.cfg.channelHandle) return;
    await this.cfg.bot.sendChannel(this.cfg.channelHandle, text);
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
EV per op: $${econ.drug.evDirty.toFixed(0)} $DIRTY · $/INF: ${econ.drug.dirtyPerInf.toFixed(2)}

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

  private dashboardLink(): string {
    return process.env.DASHBOARD_URL || 'offshore.lekker.design';
  }
}
