import { EventEmitter } from 'events';
import type {
  Trade, Liquidation, OrderbookSnapshot, HyperliquidContext,
  PolymarketData, CoinglassHeatmapLevel, VolatilityData,
  SafetyScores, DashboardState, AlertEvent,
} from '../types';
import { config } from '../config';
import { calibrateProb, getHourlyRiskLevel, getSuggestedOp } from './calibration';
import { dropProbStudentT } from './distributions';
import { buildEconomics } from './economics';
import type { OpStatsBlock } from './op-stats';
import type { OpType } from './economics';
import type { OpSummary } from './op-summary';
import type { WalletBalances } from '../feeds/onchain-balances';
import type { CorpStateBlock } from '../feeds/corp-state';
import { computeOpHeadroom } from '../feeds/corp-state';
import type { AmmRate } from '../feeds/amm-rate';
import type { TokenomicsBlock } from '../feeds/tokenomics';
import { DEFAULT_THRESHOLDS } from '../feeds/op-params';

// Operation thresholds — STALE FALLBACKS sourced from op-params.ts
// (single source of truth). Live values come from the OpParamsFeed via
// setOpParamsProvider; only used when the feed isn't wired. Stored in
// PERCENT (0.518 not 0.00518) because dropProb*() takes thresholdPct.
const THRESHOLDS = {
  extortion: DEFAULT_THRESHOLDS[0] * 100,
  arms:      DEFAULT_THRESHOLDS[1] * 100,
  drug:      DEFAULT_THRESHOLDS[2] * 100,
};
// Rolling buffer with time-based eviction
class TimeBuffer<T extends { t: number }> {
  private items: T[] = [];
  constructor(private maxAgeMs: number) {}

  push(item: T) {
    this.items.push(item);
    this.evict();
  }

  evict() {
    const cutoff = Date.now() - this.maxAgeMs;
    while (this.items.length > 0 && this.items[0].t < cutoff) {
      this.items.shift();
    }
  }

  get data() { this.evict(); return this.items; }
  get length() { this.evict(); return this.items.length; }
  last() { return this.items[this.items.length - 1]; }
  clear() { this.items = []; }
}

// normCdf, studentTCdf, dropProbStudentT, dropProbNormal are imported
// from ./distributions so the backtester can share the same implementation.

export class VolatilityEngine extends EventEmitter {
  // Price ticks (1-minute aggregated returns)
  private returns1m: { t: number; r: number }[] = [];
  private minuteCandles: { t: number; o: number; h: number; l: number; c: number }[] = [];
  private currentMinute: { t: number; o: number; h: number; l: number; c: number } | null = null;

  // Trade flow
  private trades = new TimeBuffer<Trade>(95 * 60_000);
  private binTrades = new TimeBuffer<Trade>(10 * 60_000);
  private bybTrades = new TimeBuffer<Trade>(10 * 60_000);

  // Liquidations
  private liqs = new TimeBuffer<Liquidation>(10 * 60_000);

  // Latest snapshots
  private binOB: OrderbookSnapshot | null = null;
  private bybOB: OrderbookSnapshot | null = null;
  private hlCtx: HyperliquidContext | null = null;
  private polyData: PolymarketData | null = null;
  private heatmap: CoinglassHeatmapLevel[] = [];

  // State
  private ethPrice: number | null = null;
  private ethPriceStart: number | null = null;
  private startTime = Date.now();
  private tickCount = 0;

  // Connections
  private connections = {
    binance: false, bybit: false, hyperliquid: false,
    polymarket: false, coinglass: false,
  };

  // Alerts
  private lastAlertTime = 0;
  private lastDangerHigh = false;

  // Student-t degrees of freedom
  private studentTDf = config.studentTDf;

  // Optional providers wired by index.ts so the engine doesn't depend on Storage.
  // getOpStats: returns the latest aggregated op-outcome stats for UI display.
  // getEmpiricalFractions: returns per-op overrides for the failure reward
  //   fraction once the user has logged enough outcomes.
  private getOpStats: (() => OpStatsBlock) | null = null;
  private getEmpiricalFractions: (() => Partial<Record<OpType, number>>) | null = null;
  private getActivityBundle: (() => { last1h: OpSummary; last24h: OpSummary; sinceSession: OpSummary }) | null = null;
  // Danger-v2 signal providers (network-health + eth-velocity)
  private getNetworkHealth: (() => import('../feeds/network-health').NetworkHealthSnapshot | null) | null = null;
  private getEthVelocitySnap: (() => import('./eth-velocity-signal').EthVelocitySnapshot | null) | null = null;
  // Live op-params provider (live-sampled liquidation thresholds — replaces hardcoded THRESHOLDS map)
  private getOpParamsSnap: (() => import('../feeds/op-params').OpParamsSnapshot | null) | null = null;
  // Whale trades provider (operator-only intel; stripped from public state)
  private getWhaleTradesSnap: (() => import('../feeds/whale-trades').WhaleTradesSnapshot | null) | null = null;
  // WhaleClaims (CycleRewards claim events) — operator-only
  private getWhaleClaimsSnap: (() => import('../feeds/whale-claims').WhaleClaimsSnapshot | null) | null = null;
  // KumbayaLP (Mint/Burn/Collect events on pool) — operator-only
  private getKumbayaLpSnap: (() => import('../feeds/kumbaya-lp').KumbayaLpSnapshot | null) | null = null;
  // Storage handle for the cross-table whale-stance query
  private storageRef: import('../storage/db').Storage | null = null;
  private latestWalletBalances: WalletBalances | null = null;
  private latestCorpState: CorpStateBlock | null = null;
  private latestAmmRate: AmmRate | null = null;
  private latestTokenomics: TokenomicsBlock | null = null;
  private latestDirtyPrice: import('../feeds/kumbaya-price').KumbayaPriceSnapshot | null = null;
  private latestLoadouts: import('../feeds/loadout-scanner').LoadoutBlock | null = null;

  setOpStatsProvider(
    statsFn: () => OpStatsBlock,
    fractionsFn: () => Partial<Record<OpType, number>>,
    activityFn?: () => { last1h: OpSummary; last24h: OpSummary; sinceSession: OpSummary },
  ) {
    this.getOpStats = statsFn;
    this.getEmpiricalFractions = fractionsFn;
    this.getActivityBundle = activityFn ?? null;
  }

  /** Inject the danger-v2 leading-indicator providers. */
  setDangerV2Providers(
    networkHealthFn: () => import('../feeds/network-health').NetworkHealthSnapshot | null,
    ethVelocityFn: () => import('./eth-velocity-signal').EthVelocitySnapshot | null,
  ) {
    this.getNetworkHealth = networkHealthFn;
    this.getEthVelocitySnap = ethVelocityFn;
  }

  /** Inject the live op-params provider (replaces hardcoded threshold values). */
  setOpParamsProvider(
    opParamsFn: () => import('../feeds/op-params').OpParamsSnapshot | null,
  ) {
    this.getOpParamsSnap = opParamsFn;
  }

  /** Inject the whale-trades snapshot provider (operator-only). */
  setWhaleTradesProvider(
    whaleTradesFn: () => import('../feeds/whale-trades').WhaleTradesSnapshot | null,
  ) {
    this.getWhaleTradesSnap = whaleTradesFn;
  }

  /** Inject the whale-claims snapshot provider (operator-only). */
  setWhaleClaimsProvider(
    fn: () => import('../feeds/whale-claims').WhaleClaimsSnapshot | null,
  ) {
    this.getWhaleClaimsSnap = fn;
  }

  /** Inject the Kumbaya LP-events snapshot provider (operator-only). */
  setKumbayaLpProvider(
    fn: () => import('../feeds/kumbaya-lp').KumbayaLpSnapshot | null,
  ) {
    this.getKumbayaLpSnap = fn;
  }

  /** Inject the Storage handle so getState() can compute whale-stance. */
  setStorageProvider(storage: import('../storage/db').Storage) {
    this.storageRef = storage;
  }

  /**
   * Returns live thresholds in PERCENT (so 0.3077 not 0.003077). Used by
   * dropProb calcs which take a `thresholdPct` arg. Falls back to the
   * v1 fallback constants if the feed isn't wired.
   */
  private liveThresholds(): { extortion: number; arms: number; drug: number } {
    const snap = this.getOpParamsSnap?.();
    if (!snap) return THRESHOLDS;
    return {
      extortion: snap.thresholds[0] * 100,
      arms:      snap.thresholds[1] * 100,
      drug:      snap.thresholds[2] * 100,
    };
  }

  onWalletBalances(b: WalletBalances) {
    this.latestWalletBalances = b;
  }

  onCorpState(b: CorpStateBlock) {
    this.latestCorpState = b;
  }

  onAmmRate(r: AmmRate) {
    this.latestAmmRate = r;
  }

  onTokenomics(t: TokenomicsBlock) {
    this.latestTokenomics = t;
  }

  onDirtyPrice(p: import('../feeds/kumbaya-price').KumbayaPriceSnapshot) {
    this.latestDirtyPrice = p;
  }

  onLoadouts(l: import('../feeds/loadout-scanner').LoadoutBlock) {
    this.latestLoadouts = l;
  }

  /** Most recent ETH price observed (USD). Null until first tick. */
  getEthPrice(): number | null { return this.ethPrice; }

  /**
   * Signed ETH price velocity — danger-v2 leading indicator.
   *
   * Why this exists separately from `volatility`: vol is variance (always
   * positive). Liquidations on Offshore ops only fire on DOWN moves
   * (one-sided down — confirmed by the operator and the corp-state
   * computeOpHeadroom fix). A burst of upward volatility can still be
   * a "high vol" reading but is harmless for op headroom. Velocity
   * adds direction.
   *
   * Returns:
   *   bps1m:   last 1-min log return × 10_000 (negative = fall)
   *   bps5m:   mean of last 5 1-min returns × 10_000 (smoothed slope)
   *   accel:   bps1m − previous bps1m (positive = decelerating, negative = ramping)
   *
   * All values null when fewer than 2 candles are available.
   */
  getEthVelocity(): { bps1m: number; bps5m: number; accel: number } | null {
    const r = this.returns1m;
    if (r.length < 2) return null;
    const last1 = r[r.length - 1].r;
    const prev1 = r[r.length - 2].r;
    const window5 = r.slice(-5);
    const mean5 = window5.reduce((s, x) => s + x.r, 0) / window5.length;
    return {
      bps1m: last1 * 10_000,
      bps5m: mean5 * 10_000,
      accel: (last1 - prev1) * 10_000,
    };
  }

  // --- Feed handlers ---

  onTick(price: number) {
    this.ethPrice = price;
    if (!this.ethPriceStart) this.ethPriceStart = price;
    this.tickCount++;
    this.updateMinuteCandle(price);
  }

  onTrade(trade: Trade) {
    this.trades.push(trade);
    if (trade.src === 'bin') this.binTrades.push(trade);
    else if (trade.src === 'byb') this.bybTrades.push(trade);
  }

  onLiquidation(liq: Liquidation) {
    this.liqs.push(liq);
  }

  onBinanceOB(ob: OrderbookSnapshot) { this.binOB = ob; }
  onBybitOB(ob: OrderbookSnapshot) { this.bybOB = ob; }
  onHyperliquid(data: HyperliquidContext) { this.hlCtx = data; }
  onPolymarket(data: PolymarketData) { this.polyData = data; }
  onHeatmap(data: CoinglassHeatmapLevel[]) { this.heatmap = data; }

  setConnection(source: keyof typeof this.connections, status: boolean) {
    this.connections[source] = status;
  }

  // --- Minute candle aggregation ---

  private updateMinuteCandle(price: number) {
    const now = Date.now();
    const minuteTs = Math.floor(now / 60_000) * 60_000;

    if (!this.currentMinute || this.currentMinute.t !== minuteTs) {
      // Close previous candle
      if (this.currentMinute) {
        this.minuteCandles.push(this.currentMinute);
        // Keep 95 minutes of candles
        if (this.minuteCandles.length > 95) this.minuteCandles.shift();

        // Calculate return
        const prev = this.minuteCandles.length >= 2
          ? this.minuteCandles[this.minuteCandles.length - 2].c
          : this.currentMinute.o;
        const ret = Math.log(this.currentMinute.c / prev);
        this.returns1m.push({ t: this.currentMinute.t, r: ret });
        if (this.returns1m.length > 95) this.returns1m.shift();
      }

      this.currentMinute = { t: minuteTs, o: price, h: price, l: price, c: price };
    } else {
      this.currentMinute.h = Math.max(this.currentMinute.h, price);
      this.currentMinute.l = Math.min(this.currentMinute.l, price);
      this.currentMinute.c = price;
    }
  }

  // --- Volatility calculations ---

  private calcVol(windowMinutes: number): number | null {
    const returns = this.returns1m.slice(-windowMinutes);
    if (returns.length < Math.min(3, windowMinutes)) return null;

    const mean = returns.reduce((s, r) => s + r.r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r.r - mean) ** 2, 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    return stdDev * Math.sqrt(525600) * 100; // annualized %
  }

  // Primary: Student-t based drop probability (fat tails)
  private calcDropProbStudentT(windowMinutes: number, thresholdPct: number): number {
    const vol = this.calcVol(windowMinutes);
    if (vol === null) return 0.5;
    return dropProbStudentT(vol, windowMinutes, thresholdPct, this.studentTDf);
  }

  private getVolatility(): VolatilityData {
    const vol5m = this.calcVol(5);
    const vol30m = this.calcVol(30);
    const vol90m = this.calcVol(90);

    const refVol = vol30m ?? vol5m ?? 0;
    const regime = refVol === 0 ? 'unknown' as const :
                   refVol < 40 ? 'low' as const :
                   refVol < 80 ? 'medium' as const : 'high' as const;

    // Raw model probabilities — Student-t is primary, normal is fallback.
    // Thresholds come from the LIVE OpParamsFeed so probabilities reflect
    // current leverage (post-recalibration + weekend mode if active).
    const liveTh = this.liveThresholds();
    const rawExtortion = this.calcDropProbStudentT(5, liveTh.extortion);
    const rawArms = this.calcDropProbStudentT(30, liveTh.arms);
    const rawDrug = this.calcDropProbStudentT(90, liveTh.drug);

    // Calibrated probabilities (corrected for fat tails + hourly pattern)
    const utcHour = new Date().getUTCHours();
    const probExtortion = calibrateProb(rawExtortion, 'extortion', utcHour);
    const probArms = calibrateProb(rawArms, 'arms', utcHour);
    const probDrug = calibrateProb(rawDrug, 'drug', utcHour);

    return {
      vol5m, vol30m, vol90m, regime,
      probExtortion,
      probArms,
      probDrug,
    };
  }

  // --- CVD calculations ---

  private calcCvd(trades: Trade[], windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let cvd = 0;
    for (const t of trades) {
      if (t.t >= cutoff) cvd += t.buy ? t.usd : -t.usd;
    }
    return cvd;
  }

  private getCvdHistory(): { t: number; v: number }[] {
    // Build 1-minute CVD history from recent trades
    const allTrades = this.trades.data;
    if (allTrades.length === 0) return [];

    const buckets = new Map<number, number>();
    for (const t of allTrades) {
      const minute = Math.floor(t.t / 60_000) * 60_000;
      buckets.set(minute, (buckets.get(minute) || 0) + (t.buy ? t.usd : -t.usd));
    }

    let cumulative = 0;
    const entries = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
    return entries.map(([t, v]) => {
      cumulative += v;
      return { t, v: cumulative };
    });
  }

  // --- Liquidation analysis ---

  private getLiqAnalysis() {
    const now = Date.now();
    const recentLiqs = this.liqs.data;

    let longUsd5m = 0, shortUsd5m = 0;
    const liqsPerMinute: number[] = [];

    // Count liqs per minute over last 5 minutes
    for (let i = 0; i < 5; i++) {
      const start = now - (i + 1) * 60_000;
      const end = now - i * 60_000;
      liqsPerMinute.push(
        recentLiqs.filter(l => l.t >= start && l.t < end).reduce((s, l) => s + l.usd, 0)
      );
    }

    for (const l of recentLiqs) {
      if (l.t >= now - 5 * 60_000) {
        if (l.side === 'long') longUsd5m += l.usd;
        else shortUsd5m += l.usd;
      }
    }

    // Velocity: are liqs accelerating?
    const velocity = liqsPerMinute[0] - (liqsPerMinute[1] || 0);
    const totalRecent = liqsPerMinute.reduce((s, v) => s + v, 0);

    let cascadeRisk: 'LOW' | 'ELEVATED' | 'HIGH' | 'CRITICAL' = 'LOW';
    if (totalRecent > 500_000) cascadeRisk = 'ELEVATED';
    if (totalRecent > 2_000_000 || velocity > 500_000) cascadeRisk = 'HIGH';
    if (totalRecent > 5_000_000 || velocity > 2_000_000) cascadeRisk = 'CRITICAL';

    return { longUsd5m, shortUsd5m, velocity, cascadeRisk, totalRecent };
  }

  // --- Safety score calculation ---

  private calcScores(): SafetyScores {
    const vol = this.getVolatility();
    const liq = this.getLiqAnalysis();

    const allTrades = this.trades.data;
    const cvd1m = this.calcCvd(allTrades, 60_000);
    const cvd5m = this.calcCvd(allTrades, 5 * 60_000);
    const binCvd5m = this.calcCvd(this.binTrades.data, 5 * 60_000);
    const bybCvd5m = this.calcCvd(this.bybTrades.data, 5 * 60_000);

    // CVD divergence: different when exchanges disagree
    const cvdDivergence = (binCvd5m !== 0 && bybCvd5m !== 0)
      ? Math.abs(Math.sign(binCvd5m) - Math.sign(bybCvd5m)) / 2
      : 0;

    // Taker buy/sell ratio
    const recentTrades = allTrades.filter(t => t.t >= Date.now() - 5 * 60_000);
    const buyVol = recentTrades.filter(t => t.buy).reduce((s, t) => s + t.usd, 0);
    const sellVol = recentTrades.filter(t => !t.buy).reduce((s, t) => s + t.usd, 0);
    const takerRatio = (buyVol + sellVol) > 0 ? buyVol / (buyVol + sellVol) : 0.5;

    // OB imbalance (prefer Binance, fall back to Bybit)
    const ob = this.binOB ?? this.bybOB;
    const obImbalance = ob?.imbalance ?? 0;

    // IV/RV spread from Polymarket
    let ivrvSpread = 0;
    if (this.polyData && vol.probExtortion > 0) {
      // Poly probability is P(ETH drops > 0.25% in 5 min)
      // Compare to our realized vol model's probability
      ivrvSpread = Math.max(0, this.polyData.probability - vol.probExtortion);
    }

    // Funding heat
    const fundingHeat = this.hlCtx
      ? Math.min(1, Math.abs(this.hlCtx.funding) / 0.001) // 0.1% funding = max heat
      : 0;

    // --- Composite danger score (0-100) — v2 reweighted (2026-05-08) ---
    //
    // v2 redistributes weight TOWARD the new game-internal & directional
    // signals (NetworkHealth, EthVelocity) and away from indirect proxies
    // (vol RV, CVD). The old signals are still useful at the margin but
    // were over-weighted given that vol is direction-blind and CVD is
    // CEX-specific.
    //
    // New target distribution:
    //   25  vol regime (was 35)
    //   25  game liq velocity (NEW — network-health snapshot)
    //   15  ETH velocity (NEW — signed rate-of-change)
    //   15  CVD pressure (was 20)
    //    8  OB imbalance (was 12)
    //    7  CEX liq cascade (was 15) — still relevant but down-weighted vs game-internal
    //    5  CVD divergence (was 8)
    //   ───
    //  100  total
    //
    // Funding heat & IV/RV moved into per-op scoring (see calcSafety),
    // not into the composite, since they're op-type-agnostic markers.
    let danger = 0;

    // Vol regime (0-25)
    const refVol = vol.vol30m ?? vol.vol5m ?? 0;
    if (refVol > 120) danger += 25;
    else if (refVol > 80) danger += 18;
    else if (refVol > 60) danger += 13;
    else if (refVol > 40) danger += 7;
    else danger += 2;

    // Game liq velocity (0-25) — danger-v2 PRIMARY new component.
    // Critical drug or arms cascade → 25; elevated → 12; safe → 0.
    const nh = this.getNetworkHealth ? this.getNetworkHealth() : null;
    if (nh) {
      if (nh.cascadeRisk === 'critical' || nh.drugRisk === 'critical' || nh.armsRisk === 'critical') {
        danger += 25;
      } else if (nh.cascadeRisk === 'elevated' || nh.drugRisk === 'elevated' || nh.armsRisk === 'elevated') {
        danger += 12;
      }
    }

    // ETH velocity (0-15) — signed rate-of-change. Only DOWN moves count.
    const ev = this.getEthVelocitySnap ? this.getEthVelocitySnap() : null;
    if (ev && ev.bps1m != null) {
      if (ev.risk === 'critical') danger += 15;
      else if (ev.risk === 'elevated') danger += 7;
    }

    // CVD pressure (0-15)
    if (cvd5m < 0) {
      const pressure = Math.min(1, Math.abs(cvd5m) / 5_000_000);
      danger += pressure * 15;
    }

    // OB imbalance (0-8)
    if (obImbalance < 0) {
      danger += Math.min(1, Math.abs(obImbalance) / 0.5) * 8;
    }

    // CEX liq cascade (0-7) — down-weighted; complementary to game liq velocity
    const cascadeScore = { LOW: 0, ELEVATED: 2, HIGH: 4, CRITICAL: 7 };
    danger += cascadeScore[liq.cascadeRisk];

    // CVD divergence (0-5)
    danger += cvdDivergence * 5;

    // (Funding heat & IV/RV no longer in composite — fed into per-op scoring below)

    danger = Math.round(Math.min(100, Math.max(0, danger)));

    // --- Per-operation safety scores ---
    const calcSafety = (baseProb: number, sensitivities: { cvd: number; ob: number; liq: number; div: number; iv: number }) => {
      let score = (1 - baseProb) * 100;

      // CVD penalty
      if (cvd5m < 0) score -= Math.min(15, Math.abs(cvd5m) / 1_000_000 * 10) * sensitivities.cvd;

      // OB penalty
      if (obImbalance < -0.1) score -= Math.abs(obImbalance) * 15 * sensitivities.ob;

      // Liq penalty
      const liqPenalty = { LOW: 0, ELEVATED: 5, HIGH: 12, CRITICAL: 25 };
      score -= liqPenalty[liq.cascadeRisk] * sensitivities.liq;

      // Funding penalty (extreme funding = mean reversion risk)
      if (this.hlCtx && Math.abs(this.hlCtx.funding) > 0.0005) {
        score -= fundingHeat * 8;
      }

      // CVD divergence penalty
      score -= cvdDivergence * 10 * sensitivities.div;

      // IV/RV spread penalty
      score -= Math.min(12, ivrvSpread * 60) * sensitivities.iv;

      return Math.round(Math.min(100, Math.max(0, score)));
    };

    const extortion = calcSafety(vol.probExtortion, { cvd: 1.0, ob: 1.0, liq: 1.0, div: 1.0, iv: 1.0 });
    const arms = calcSafety(vol.probArms, { cvd: 0.7, ob: 0.7, liq: 0.8, div: 0.5, iv: 0.7 });
    const drug = calcSafety(vol.probDrug, { cvd: 0.4, ob: 0.4, liq: 0.5, div: 0.3, iv: 0.4 });

    return {
      extortion, arms, drug,
      probExtortion: vol.probExtortion,
      probArms: vol.probArms,
      probDrug: vol.probDrug,
      cvd1m, cvd5m, takerRatio,
      binCvd5m, bybCvd5m, cvdDivergence,
      liqLong5m: liq.longUsd5m,
      liqShort5m: liq.shortUsd5m,
      liqVelocity: liq.velocity,
      cascadeRisk: liq.cascadeRisk,
      ivrvSpread,
      dangerScore: danger,
    };
  }

  // --- Full dashboard state ---

  getState(): DashboardState {
    const vol = this.getVolatility();
    const scores = this.calcScores();

    // Check alerts
    this.checkAlerts(scores);

    const activeSources = Object.values(this.connections).filter(Boolean).length;
    const utcHour = new Date().getUTCHours();
    const empiricalFractions = this.getEmpiricalFractions?.() ?? {};
    // Thread the LIVE INF cost from OpParamsFeed so the economics
    // calc reflects the current contract recalibration (~9-12 INF as
    // of 2026-05-09; floats with $DIRTY price). Falls back to the
    // historical 5.0 if the snapshot isn't available yet.
    const opParamsSnap = this.getOpParamsSnap?.();
    const liveInfCost = opParamsSnap?.infCostPerOp ?? null;
    const economics = buildEconomics(
      {
        extortion: vol.probExtortion,
        arms: vol.probArms,
        drug: vol.probDrug,
      },
      empiricalFractions,
      liveInfCost,
    );
    // In public mode, also strip the historical op-stats and activity rollups
    // (they would otherwise leak the operator's win/loss history and earnings).
    const opStats = config.publicMode ? null : (this.getOpStats?.() ?? null);
    const activity = config.publicMode ? null : (this.getActivityBundle?.() ?? null);

    return {
      publicMode: config.publicMode,
      tgBotUsername: config.publicMode ? config.tgBotUsername : undefined,
      tgChannelUsername: config.publicMode ? config.tgChannelUsername : undefined,
      ethPrice: this.ethPrice,
      ethPriceStart: this.ethPriceStart,
      volatility: vol,
      scores,
      economics,
      orderbook: {
        binance: this.binOB ?? this.emptyOB(),
        bybit: this.bybOB ?? this.emptyOB(),
      },
      cvd: {
        binance: this.calcCvd(this.binTrades.data, 5 * 60_000),
        bybit: this.calcCvd(this.bybTrades.data, 5 * 60_000),
        combined: this.calcCvd(this.trades.data, 5 * 60_000),
        history: this.getCvdHistory(),
      },
      hyperliquid: this.hlCtx,
      polymarket: this.polyData,
      heatmap: this.heatmap,
      liquidations: this.liqs.data.slice(-20),
      connections: { ...this.connections },
      meta: {
        tickCount: this.tickCount,
        tradeRate: this.trades.data.filter(t => t.t >= Date.now() - 60_000).length,
        uptime: Date.now() - this.startTime,
        sources: activeSources,
      },
      calibration: {
        hourlyRisk: getHourlyRiskLevel(utcHour),
        utcHour,
        suggestion: getSuggestedOp(
          { extortion: vol.probExtortion, arms: vol.probArms, drug: vol.probDrug },
          utcHour
        ),
      },
      opStats,
      walletBalances: this.latestWalletBalances,
      // Enrich corp state with live op-headroom — computed here (not in the
      // feed) because it requires the current ETH price, which lives in this
      // engine. Pure function; safe to call every getState().
      corpState: this.latestCorpState
        ? {
            ...this.latestCorpState,
            corps: this.latestCorpState.corps.map(c => ({
              ...c,
              opHeadroom: computeOpHeadroom(c, this.ethPrice ?? null),
            })),
          }
        : null,
      ammRate: this.latestAmmRate,
      dirtyPrice: this.latestDirtyPrice,
      loadouts: this.latestLoadouts,
      tokenomics: this.latestTokenomics,
      activity,
      // Danger-v2 leading-indicator snapshots (null when feed not running).
      // Public state strips these — see api/server pickPublicState.
      networkHealth: this.getNetworkHealth ? this.getNetworkHealth() : null,
      ethVelocity:   this.getEthVelocitySnap ? this.getEthVelocitySnap() : null,
      // Live op params (current liquidation thresholds) — public-safe by
      // design (just chain-derived numbers everyone can read themselves)
      opParams: this.getOpParamsSnap ? this.getOpParamsSnap() : null,
      // Whale trades — OPERATOR-ONLY. publicMode skips this; pickPublicState
      // also strips it as a defense-in-depth.
      whaleTrades: config.publicMode
        ? null
        : (this.getWhaleTradesSnap ? this.getWhaleTradesSnap() : null),
      // WhaleClaims, KumbayaLP, WhaleStance — also operator-only intel
      whaleClaims: config.publicMode
        ? null
        : (this.getWhaleClaimsSnap ? this.getWhaleClaimsSnap() : null),
      kumbayaLp: config.publicMode
        ? null
        : (this.getKumbayaLpSnap ? this.getKumbayaLpSnap() : null),
      whaleStance: config.publicMode || !this.storageRef
        ? null
        : this.storageRef.getWhaleStance(24 * 3600_000, 25),
    } as any;
  }

  // For storing periodic snapshots
  getIndicatorSnapshot() {
    const vol = this.getVolatility();
    const scores = this.calcScores();
    const ob = this.binOB ?? this.bybOB;

    return {
      timestamp: Date.now(),
      vol5m: vol.vol5m,
      vol30m: vol.vol30m,
      vol90m: vol.vol90m,
      regime: vol.regime,
      danger_score: scores.dangerScore,
      score_extortion: scores.extortion,
      score_arms: scores.arms,
      score_drug: scores.drug,
      cvd_5m: scores.cvd5m,
      ob_imbalance: ob?.imbalance ?? 0,
      liq_velocity: scores.liqVelocity,
      funding: this.hlCtx?.funding ?? null,
      eth_price: this.ethPrice ?? 0,
    };
  }

  // --- Alerts ---

  private checkAlerts(scores: SafetyScores) {
    const now = Date.now();
    if (now - this.lastAlertTime < config.alertCooldownMinutes * 60_000) return;

    const dangerHigh = scores.dangerScore >= config.alertDangerHigh;
    const dangerLow = scores.dangerScore <= config.alertDangerLow;

    if (dangerHigh && !this.lastDangerHigh) {
      this.emitAlert({
        type: 'danger_high',
        message: `⚠️ DANGER HIGH (${scores.dangerScore}/100) — Avoid operations. Cascade: ${scores.cascadeRisk}`,
        dangerScore: scores.dangerScore,
        timestamp: now,
      });
      this.lastDangerHigh = true;
    }

    if (dangerLow && this.lastDangerHigh) {
      this.emitAlert({
        type: 'danger_low',
        message: `✅ DANGER LOW (${scores.dangerScore}/100) — Safe window. Ext: ${scores.extortion} | Arms: ${scores.arms} | Drug: ${scores.drug}`,
        dangerScore: scores.dangerScore,
        timestamp: now,
      });
      this.lastDangerHigh = false;
    }

    if (scores.cascadeRisk === 'CRITICAL') {
      this.emitAlert({
        type: 'cascade',
        message: `🔴 CRITICAL CASCADE — Liq velocity extreme. All operations dangerous.`,
        dangerScore: scores.dangerScore,
        timestamp: now,
      });
    }
  }

  private emitAlert(alert: AlertEvent) {
    this.lastAlertTime = alert.timestamp;
    this.emit('alert', alert);
  }

  private emptyOB(): OrderbookSnapshot {
    return {
      bids: [], asks: [], imbalance: 0,
      bidTotal: 0, askTotal: 0, spread: 0, spreadPct: 0,
      bidWall: null, askWall: null,
    };
  }
}
