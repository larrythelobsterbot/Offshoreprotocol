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
}

export interface HedgeSizing {
  corpsActive: number;
  infCostPerOp: number;
  totalInfAtRisk: number;
  /** Drug threshold as a fraction (e.g. 0.00386 for 0.386%). */
  drugThreshold: number;
  /** RedStone ETH price at the moment of sizing. */
  ethPrice: number;
  /** Short notional in USDM = totalInfAtRisk / drugThreshold. */
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
 */
export function computeHedgeSizing(params: {
  corpAddresses: string[];
  infCostPerOp: number;
  drugThreshold: number;
  ethPrice: number;
  leverage: number;
}): HedgeSizing {
  const corpsActive = params.corpAddresses.length;
  const totalInfAtRisk = corpsActive * params.infCostPerOp;
  const notional = params.drugThreshold > 0
    ? totalInfAtRisk / params.drugThreshold
    : 0;
  const margin = params.leverage > 0 ? notional / params.leverage : 0;
  const takeProfitPrice = params.ethPrice * (1 - params.drugThreshold);
  return {
    corpsActive,
    infCostPerOp: params.infCostPerOp,
    totalInfAtRisk,
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
    };
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

    const sizing = computeHedgeSizing({
      corpAddresses: params.corpAddresses,
      infCostPerOp: params.infCostPerOp,
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
      notional: sizing.notional.toFixed(2),
      margin: sizing.margin.toFixed(2),
      ethEntry: sizing.ethPrice.toFixed(2),
      tp: sizing.takeProfitPrice.toFixed(2),
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
