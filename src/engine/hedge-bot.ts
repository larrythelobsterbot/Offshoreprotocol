// ============================================================
// HedgeBot — World Exchange hedge framework for Drug-op batches.
//
// Concept:
//   When CorpBot bootstraps a batch of Drug ops, simultaneously open
//   a short on World Exchange's ETH-perp sized to recover the INF
//   stake if all ops fail. Take-profit at the Drug liquidation
//   threshold. If ETH drops past threshold → ops fail (lose INF) AND
//   short hits TP (recovers INF). If ETH stays above threshold →
//   ops succeed (INF refunded) AND short is closed at modest cost
//   (fees + adverse selection).
//
// World uses the same RedStone oracle as Offshore Protocol, so the
// hedge fires at exactly the price the game enforces — no oracle drift.
//
// PHASE 1 (this file): SHADOW MODE ONLY. The bot computes sizing
// and logs what it WOULD do without executing any World trades. The
// hedge_shadow_log table accumulates evidence for whether the math
// matches reality before we flip a switch to live execution.
//
// PHASE 2 (next): wire in the SDK calls (open/close/TP).
// PHASE 3 (later): migrate cliff defense to RedStone-derived pFail.
// ============================================================

import { EventEmitter } from 'events';
import { logger } from '../logger';
import type { Storage } from '../storage/db';

export type HedgeMode = 'shadow' | 'live';

/**
 * Activation policies — when SHOULD the hedge attempt to open?
 * Independent of the shadow/live mode (which decides whether the
 * order is actually placed on World).
 */
export type HedgeActivationPolicy = 'danger-only' | 'us-hours' | 'always' | 'off';

/** HKT hours considered "US market hours" — 22:00 HKT ≈ 14:00 UTC ≈ 09:00 ET. */
const US_HOURS_HKT = [22, 23, 0, 1, 2, 3, 4];

export interface HedgeBotConfig {
  storage: Storage;
  /** Default 10 (World's max leverage on ETH-perp at brief writing). */
  leverage: number;
  /** Hard safety cap on margin per hedge. Skip if computed margin exceeds this. */
  maxMarginUsdm: number;
  /** Don't hedge if fewer than this many corps in the batch. */
  minCorpsForHedge: number;
  /** Start in shadow. Flip via setMode('live') only after operator confirms POC. */
  shadowMode: boolean;
  /** Disable hedge entirely (also short-circuits shadow logging). */
  disabled: boolean;
  /** Operator-configurable estimate of per-trade fee for shadow accounting. */
  feeEstimateUsdmPerTrade: number;
  /** Activation policy — when (under what conditions) does the hedge fire? */
  activationPolicy?: HedgeActivationPolicy;
  /** Minimum danger score for 'danger-only' / 'us-hours' policies. */
  minDangerScore?: number;
  /** Refuse to open if RedStone reports stale at decision time. */
  requireRedstoneAlive?: boolean;
}

export interface HedgeSizing {
  corpsActive: number;
  /** Per-op INF burn in INF token units (from OpParamsFeed). */
  infCostPerOp: number;
  /** corpsActive × infCostPerOp — total INF tokens at risk this batch. */
  totalInfAtRisk: number;
  /** USD-per-INF-token estimate fed into the sizing calc. Surfaced so
   *  shadow logs + dashboard reveal the assumption that drove the
   *  notional. */
  infUsdEstimate: number;
  /** USD value of the INF stake at risk (totalInfAtRisk × infUsdEstimate).
   *  THIS is the dollar loss-on-full-liquidation the hedge needs to cover. */
  totalInfAtRiskUsd: number;
  /** Drug threshold as a fraction (e.g. 0.00386 for 0.386%). */
  drugThreshold: number;
  /** RedStone ETH price at the moment of sizing. */
  ethPrice: number;
  /** Short notional in USDM = totalInfAtRiskUsd / drugThreshold.
   *  A drop of `drugThreshold` from `ethPrice` then profits ≈ totalInfAtRiskUsd. */
  notional: number;
  /** Margin required = notional / leverage. */
  margin: number;
  /** TP = ethPrice * (1 - drugThreshold). */
  takeProfitPrice: number;
}

export interface ActiveHedge {
  /** Opaque id from World once live; null in shadow. */
  positionId: string | null;
  notional: number;
  margin: number;
  entryPrice: number;
  takeProfitPrice: number;
  openedAt: number;
  corpsHedged: string[];
  drugThreshold: number;
  infAtRisk: number;
}

export interface HedgeState {
  enabled: boolean;
  mode: HedgeMode;
  disabled: boolean;
  activeHedge: ActiveHedge | null;
  lastSizing: HedgeSizing | null;
  stats: {
    totalShadowOpens: number;
    totalShadowCloses: number;
    /** Sum of theoretical_pnl across all shadow closes. */
    totalShadowPnl: number;
    /** Sum of fee estimates. */
    totalShadowFees: number;
    /** Closes where the short would have triggered TP (any op failed). */
    triggered: number;
    /** Closes where shadow P&L > 0. */
    wouldProfit: number;
  };
}

/**
 * Compute hedge sizing from current op-params + RedStone price.
 * Pure function — split out for /api state surfacing + unit testing.
 *
 * ## Sizing math (corrected 2026-05-12)
 *
 * Goal: short ETH such that if ALL corps liquidate (price drops by
 * `drugThreshold`), the short's profit roughly offsets the lost INF.
 *
 * Loss on full-liquidation:
 *   loss_usd = corpsActive × infCostPerOp × infUsdEstimate
 *
 * Short profit on threshold drop:
 *   profit_usd = notional × drugThreshold
 *
 * Setting equal and solving:
 *   notional = (corpsActive × infCostPerOp × infUsdEstimate) / drugThreshold
 *
 * ⚠ `infUsdEstimate` is the conversion from INF tokens → USD. There is
 * no live INF/USDM price feed in the codebase (INF doesn't appear to
 * have a tradeable DEX market), so this is an operator-tuned env
 * estimate (HEDGE_INF_USD_ESTIMATE, default $1.00). Previously the
 * formula treated `infCostPerOp` (INF tokens) as USD directly, which
 * SCALED the notional by 1/infUsdEstimate — under-hedged when INF was
 * worth >$1, over-hedged when <$1. The bug was latent because the
 * hedge ran in shadow mode the entire time.
 *
 * Once INF has a price feed (e.g. via a future DEX pool or auction
 * contract), `infUsdEstimate` should be replaced with a live read.
 */
export function computeHedgeSizing(params: {
  corpAddresses: string[];
  /** INF tokens burned per failed op (from OpParamsFeed.infCostPerOp). */
  infCostPerOp: number;
  /** USD per INF token (operator-tuned via HEDGE_INF_USD_ESTIMATE). */
  infUsdEstimate: number;
  drugThreshold: number;
  ethPrice: number;
  leverage: number;
}): HedgeSizing {
  const corpsActive = params.corpAddresses.length;
  const totalInfAtRisk = corpsActive * params.infCostPerOp;
  const totalInfAtRiskUsd = totalInfAtRisk * params.infUsdEstimate;
  const notional = params.drugThreshold > 0
    ? totalInfAtRiskUsd / params.drugThreshold
    : 0;
  const margin = params.leverage > 0 ? notional / params.leverage : 0;
  const takeProfitPrice = params.ethPrice * (1 - params.drugThreshold);
  return {
    corpsActive,
    infCostPerOp: params.infCostPerOp,
    totalInfAtRisk,
    infUsdEstimate: params.infUsdEstimate,
    totalInfAtRiskUsd,
    drugThreshold: params.drugThreshold,
    ethPrice: params.ethPrice,
    notional,
    margin,
    takeProfitPrice,
  };
}

export class HedgeBot extends EventEmitter {
  private cfg: Required<HedgeBotConfig>;
  private state: HedgeState;
  private activationPolicy: HedgeActivationPolicy;
  private minDangerScore: number;
  private requireRedstoneAlive: boolean;

  constructor(cfg: HedgeBotConfig) {
    super();
    this.cfg = {
      storage: cfg.storage,
      leverage: cfg.leverage,
      maxMarginUsdm: cfg.maxMarginUsdm,
      minCorpsForHedge: cfg.minCorpsForHedge,
      shadowMode: cfg.shadowMode,
      disabled: cfg.disabled,
      feeEstimateUsdmPerTrade: cfg.feeEstimateUsdmPerTrade,
      activationPolicy:    cfg.activationPolicy    ?? 'danger-only',
      minDangerScore:      cfg.minDangerScore      ?? 40,
      requireRedstoneAlive: cfg.requireRedstoneAlive ?? true,
    };
    this.activationPolicy    = this.cfg.activationPolicy;
    this.minDangerScore      = this.cfg.minDangerScore;
    this.requireRedstoneAlive = this.cfg.requireRedstoneAlive;
    this.state = {
      enabled: !cfg.disabled,
      mode: cfg.shadowMode ? 'shadow' : 'live',
      disabled: cfg.disabled,
      activeHedge: null,
      lastSizing: null,
      stats: {
        totalShadowOpens: 0,
        totalShadowCloses: 0,
        totalShadowPnl: 0,
        totalShadowFees: 0,
        triggered: 0,
        wouldProfit: 0,
      },
    };
    // Pre-fill stats from the shadow log on startup so /bot hedge stats
    // doesn't reset to zero after a pm2 restart.
    this.hydrateStatsFromDb();
  }

  // ── Public API ───────────────────────────────────────────────

  /** Snapshot for /api state + /bot hedge status. */
  getState(): HedgeState { return { ...this.state, stats: { ...this.state.stats } }; }

  getActivationPolicy(): HedgeActivationPolicy { return this.activationPolicy; }
  getMinDanger(): number { return this.minDangerScore; }

  setActivationPolicy(p: HedgeActivationPolicy): void {
    if (this.activationPolicy === p) return;
    this.activationPolicy = p;
    logger.info({ policy: p }, '[HedgeBot] activation policy');
  }

  setMinDanger(n: number): { ok: boolean; reason?: string } {
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { ok: false, reason: 'minDanger must be 0..100' };
    }
    this.minDangerScore = Math.round(n);
    logger.info({ minDanger: this.minDangerScore }, '[HedgeBot] minDanger updated');
    return { ok: true };
  }

  /**
   * Decision function — should the hedge fire under the current
   * activation policy? Pure (no side effects), returns the reason so
   * callers can log a precise "why-not" message. Independent of the
   * shadow/live mode — that determines whether `open` actually happens.
   */
  shouldActivateHedge(params: {
    dangerScore: number;
    hktHour: number;
    activeCorps: number;
    redstoneAlive: boolean;
  }): { activate: boolean; reason: string } {
    if (this.cfg.disabled || !this.state.enabled) return { activate: false, reason: 'disabled' };
    if (this.activationPolicy === 'off')           return { activate: false, reason: 'policy=off' };
    if (this.requireRedstoneAlive && !params.redstoneAlive) {
      return { activate: false, reason: 'redstone stale' };
    }
    if (params.activeCorps < this.cfg.minCorpsForHedge) {
      return { activate: false, reason: `need ${this.cfg.minCorpsForHedge}+ corps (have ${params.activeCorps})` };
    }
    if (this.activationPolicy === 'always') return { activate: true, reason: 'policy=always' };
    if (this.activationPolicy === 'danger-only') {
      if (params.dangerScore < this.minDangerScore) {
        return { activate: false, reason: `danger ${params.dangerScore} < ${this.minDangerScore}` };
      }
      return { activate: true, reason: `danger ${params.dangerScore} ≥ ${this.minDangerScore}` };
    }
    if (this.activationPolicy === 'us-hours') {
      const inWindow = US_HOURS_HKT.includes(params.hktHour);
      if (!inWindow) {
        return { activate: false, reason: `HKT ${params.hktHour} outside US window` };
      }
      if (params.dangerScore < this.minDangerScore) {
        return { activate: false, reason: `US-hours: danger ${params.dangerScore} < ${this.minDangerScore}` };
      }
      return { activate: true, reason: `US-hours + danger ${params.dangerScore} ≥ ${this.minDangerScore}` };
    }
    return { activate: false, reason: `unknown policy '${this.activationPolicy}'` };
  }

  /** Operator toggles. Persisted via the caller (config files), not here. */
  setEnabled(on: boolean): void {
    this.state.enabled = on;
    logger.info({ enabled: on }, '[HedgeBot] enabled flag');
  }

  setMode(mode: HedgeMode): void {
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    this.cfg.shadowMode = mode === 'shadow';
    logger.warn({ mode }, '[HedgeBot] mode change');
    // When flipping to live, drop any stale shadow "active hedge"
    // — live execution starts fresh.
    if (mode === 'live') this.state.activeHedge = null;
  }

  /**
   * Called when CorpBot has finished a Drug-batch bootstrap.
   * Computes sizing, runs safety checks, then either logs (shadow)
   * or executes (live — Phase 2).
   */
  async onDrugBatchStart(params: {
    corpAddresses: string[];
    infCostPerOp: number;
    /** USD per INF token. Caller plumbs from config.hedgeInfUsdEstimate. */
    infUsdEstimate: number;
    drugThreshold: number;
    ethPrice: number;
    /** Optional: RedStone staleness flag — skip the hedge if stale. */
    redstoneStale?: boolean;
  }): Promise<void> {
    if (this.cfg.disabled || !this.state.enabled) {
      logger.debug('[HedgeBot] disabled — skipping batch');
      return;
    }
    if (params.redstoneStale) {
      logger.warn('[HedgeBot] RedStone stale — refusing to hedge against unanchored price');
      return;
    }
    if (params.ethPrice <= 0) {
      logger.warn('[HedgeBot] no ETH price — skipping hedge');
      return;
    }
    if (params.drugThreshold <= 0) {
      logger.warn({ drugThreshold: params.drugThreshold }, '[HedgeBot] bad drug threshold — skipping');
      return;
    }
    if (params.infCostPerOp <= 0) {
      logger.warn({ infCostPerOp: params.infCostPerOp }, '[HedgeBot] no INF cost sample — skipping');
      return;
    }
    if (params.infUsdEstimate <= 0) {
      logger.warn({ infUsdEstimate: params.infUsdEstimate }, '[HedgeBot] no INF USD estimate — skipping (set HEDGE_INF_USD_ESTIMATE)');
      return;
    }

    const sizing = computeHedgeSizing({
      corpAddresses: params.corpAddresses,
      infCostPerOp: params.infCostPerOp,
      infUsdEstimate: params.infUsdEstimate,
      drugThreshold: params.drugThreshold,
      ethPrice: params.ethPrice,
      leverage: this.cfg.leverage,
    });
    this.state.lastSizing = sizing;

    if (sizing.corpsActive < this.cfg.minCorpsForHedge) {
      logger.info({ sizing }, '[HedgeBot] below min-corps threshold — skipping');
      return;
    }
    if (sizing.margin > this.cfg.maxMarginUsdm) {
      logger.warn(
        { marginRequired: sizing.margin, cap: this.cfg.maxMarginUsdm },
        '[HedgeBot] sizing exceeds margin cap — skipping (safety)',
      );
      return;
    }

    if (this.state.mode === 'shadow') {
      this.logShadowOpen(sizing, params.corpAddresses);
      return;
    }
    // PHASE 2: live execution wiring goes here.
    logger.error('[HedgeBot] live mode not yet implemented — falling back to shadow log');
    this.logShadowOpen(sizing, params.corpAddresses);
  }

  /**
   * Called when the Drug batch resolves (op-scraper saw all the
   * TC/TL events for the corps we hedged). Closes the position.
   */
  async onDrugBatchComplete(params: {
    corpAddresses: string[];
    outcomes: Array<{ corp: string; success: boolean; dirtyEarned: number }>;
    /** Live RedStone price at close time for the theoretical P&L calc. */
    ethPriceNow: number;
  }): Promise<void> {
    if (!this.state.activeHedge) return;
    if (this.cfg.disabled) return;

    const hedge = this.state.activeHedge;
    const anyFailed = params.outcomes.some((o) => !o.success);

    // Theoretical P&L for a SHORT:
    //   pnl = notional × (entryPrice - exitPrice) / entryPrice
    // (closed at the lesser of takeProfit or live price, since TP would
    // trigger automatically if reached).
    const exitPrice = anyFailed
      ? Math.min(params.ethPriceNow, hedge.takeProfitPrice)
      : params.ethPriceNow;
    const pnlBeforeFees = hedge.notional * (hedge.entryPrice - exitPrice) / hedge.entryPrice;
    const fees = this.cfg.feeEstimateUsdmPerTrade * 2;  // open + close
    const theoreticalPnl = pnlBeforeFees - fees;

    if (this.state.mode === 'shadow') {
      this.logShadowClose(hedge, params, exitPrice, theoreticalPnl, anyFailed);
      return;
    }
    // PHASE 2: live close wiring goes here.
    logger.error('[HedgeBot] live close not yet implemented — falling back to shadow log');
    this.logShadowClose(hedge, params, exitPrice, theoreticalPnl, anyFailed);
  }

  // ── Internals ────────────────────────────────────────────────

  private logShadowOpen(sizing: HedgeSizing, corps: string[]): void {
    const now = Date.now();
    this.state.activeHedge = {
      positionId: null,
      notional: sizing.notional,
      margin: sizing.margin,
      entryPrice: sizing.ethPrice,
      takeProfitPrice: sizing.takeProfitPrice,
      openedAt: now,
      corpsHedged: [...corps],
      drugThreshold: sizing.drugThreshold,
      infAtRisk: sizing.totalInfAtRisk,
    };
    this.state.stats.totalShadowOpens++;
    try {
      this.cfg.storage.insertHedgeShadow({
        ts: now,
        event: 'open',
        corps_count: sizing.corpsActive,
        inf_cost_per_op: sizing.infCostPerOp,
        total_inf_at_risk: sizing.totalInfAtRisk,
        drug_threshold: sizing.drugThreshold,
        eth_price_entry: sizing.ethPrice,
        eth_price_exit: null,
        notional: sizing.notional,
        margin: sizing.margin,
        take_profit_price: sizing.takeProfitPrice,
        theoretical_pnl: null,
        any_op_failed: null,
        would_have_profited: null,
        fee_estimate: this.cfg.feeEstimateUsdmPerTrade,
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, '[HedgeBot] insertHedgeShadow(open) failed');
    }
    logger.info({
      shadow: true,
      corps: sizing.corpsActive,
      infAtRisk:      sizing.totalInfAtRisk.toFixed(2) + ' INF',
      infUsdEstimate: '$' + sizing.infUsdEstimate.toFixed(3),
      infAtRiskUsd:   '$' + sizing.totalInfAtRiskUsd.toFixed(2),
      notional: '$' + sizing.notional.toFixed(2),
      margin:   '$' + sizing.margin.toFixed(2),
      ethEntry: '$' + sizing.ethPrice.toFixed(2),
      tp:       '$' + sizing.takeProfitPrice.toFixed(2),
    }, '[HedgeBot] SHADOW: would open short');
  }

  private logShadowClose(
    hedge: ActiveHedge,
    params: { corpAddresses: string[]; outcomes: Array<{ success: boolean }> },
    exitPrice: number,
    theoreticalPnl: number,
    anyFailed: boolean,
  ): void {
    const now = Date.now();
    const profited = theoreticalPnl > 0 ? 1 : 0;
    this.state.stats.totalShadowCloses++;
    this.state.stats.totalShadowPnl += theoreticalPnl;
    this.state.stats.totalShadowFees += this.cfg.feeEstimateUsdmPerTrade * 2;
    if (anyFailed) this.state.stats.triggered++;
    if (profited) this.state.stats.wouldProfit++;
    try {
      this.cfg.storage.insertHedgeShadow({
        ts: now,
        event: 'close',
        corps_count: hedge.corpsHedged.length,
        inf_cost_per_op: hedge.infAtRisk / Math.max(1, hedge.corpsHedged.length),
        total_inf_at_risk: hedge.infAtRisk,
        drug_threshold: hedge.drugThreshold,
        eth_price_entry: hedge.entryPrice,
        eth_price_exit: exitPrice,
        notional: hedge.notional,
        margin: hedge.margin,
        take_profit_price: hedge.takeProfitPrice,
        theoretical_pnl: theoreticalPnl,
        any_op_failed: anyFailed ? 1 : 0,
        would_have_profited: profited as 0 | 1,
        fee_estimate: this.cfg.feeEstimateUsdmPerTrade * 2,
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, '[HedgeBot] insertHedgeShadow(close) failed');
    }
    logger.info({
      shadow: true,
      corps: hedge.corpsHedged.length,
      anyFailed,
      entryPrice: hedge.entryPrice.toFixed(2),
      exitPrice: exitPrice.toFixed(2),
      theoreticalPnl: theoreticalPnl.toFixed(2),
    }, '[HedgeBot] SHADOW: would close short');
    this.state.activeHedge = null;
  }

  private hydrateStatsFromDb(): void {
    try {
      // Pull last 30 days of shadow data so the dashboard / /bot hedge
      // stats survive pm2 restarts with continuous numbers.
      const cutoff = Date.now() - 30 * 86400_000;
      const s = this.cfg.storage.getHedgeShadowStats(cutoff);
      this.state.stats.totalShadowOpens   = s.opens;
      this.state.stats.totalShadowCloses  = s.closes;
      this.state.stats.totalShadowPnl     = s.totalTheoreticalPnl;
      this.state.stats.totalShadowFees    = s.totalFees;
      this.state.stats.triggered          = s.triggered;
      this.state.stats.wouldProfit        = s.wouldProfit;
    } catch (err: any) {
      logger.warn({ err: err.message }, '[HedgeBot] hydrateStatsFromDb failed (non-fatal)');
    }
  }
}
