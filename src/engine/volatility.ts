import { EventEmitter } from 'events';
import type {
  Trade, Liquidation, OrderbookSnapshot, HyperliquidContext,
  PolymarketData, CoinglassHeatmapLevel, VolatilityData,
  SafetyScores, DashboardState, AlertEvent,
} from '../types';
import { config } from '../config';
import { calibrateProb, getHourlyRiskLevel, getSuggestedOp } from './calibration';

// Operation thresholds (leverage-derived max drop %)
const THRESHOLDS = {
  extortion: 0.17,
  arms: 0.71,
  drug: 2.0,
};
// Time windows in ms
const WINDOWS = {
  extortion: 5 * 60_000,
  arms: 30 * 60_000,
  drug: 90 * 60_000,
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

// Normal CDF approximation
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327;
  const p = d * Math.exp(-x * x / 2) * t *
    (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// --- Student-t CDF via regularized incomplete beta function ---

// Log-gamma using Lanczos approximation
function logGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    // Reflection formula
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Regularized incomplete beta function I_x(a, b) via continued fraction
function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Use symmetry relation for better convergence
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedBeta(1 - x, b, a);
  }

  const lnBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  // Lentz's continued fraction algorithm
  const maxIter = 200;
  const eps = 1e-14;
  let f = 1;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < eps) d = eps;
  d = 1 / d;
  f = d;

  for (let m = 1; m <= maxIter; m++) {
    // Even step
    let num = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + num * d;
    if (Math.abs(d) < eps) d = eps;
    c = 1 + num / c;
    if (Math.abs(c) < eps) c = eps;
    d = 1 / d;
    f *= c * d;

    // Odd step
    num = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d;
    if (Math.abs(d) < eps) d = eps;
    c = 1 + num / c;
    if (Math.abs(c) < eps) c = eps;
    d = 1 / d;
    const delta = c * d;
    f *= delta;

    if (Math.abs(delta - 1) < eps) break;
  }

  return front * f;
}

// Student-t CDF for given degrees of freedom
function studentTCdf(x: number, df: number): number {
  const xt = df / (df + x * x);
  const beta = regularizedBeta(xt, df / 2, 0.5);
  if (x >= 0) {
    return 1 - 0.5 * beta;
  } else {
    return 0.5 * beta;
  }
}

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

    const volPerMin = (vol / 100) / Math.sqrt(525600);
    const windowVol = volPerMin * Math.sqrt(windowMinutes);
    const threshold = thresholdPct / 100;

    // Student-t: scale the z-score for the t-distribution
    // Under t-distribution, the scale parameter sigma relates to normal sigma
    // with a factor of sqrt(df/(df-2)) for df>2
    const df = this.studentTDf;
    const scale = df > 2 ? Math.sqrt((df - 2) / df) : 1;
    const t = (threshold / windowVol) * scale;
    return 1 - studentTCdf(t, df);
  }

  // Fallback: Normal CDF based drop probability
  private calcDropProbNormal(windowMinutes: number, thresholdPct: number): number {
    const vol = this.calcVol(windowMinutes);
    if (vol === null) return 0.5;

    const volPerMin = (vol / 100) / Math.sqrt(525600);
    const windowVol = volPerMin * Math.sqrt(windowMinutes);
    const threshold = thresholdPct / 100;

    // P(drop > threshold) using one-sided normal CDF
    const z = threshold / windowVol;
    return 1 - normCdf(z);
  }

  private getVolatility(): VolatilityData {
    const vol5m = this.calcVol(5);
    const vol30m = this.calcVol(30);
    const vol90m = this.calcVol(90);

    const refVol = vol30m ?? vol5m ?? 0;
    const regime = refVol === 0 ? 'unknown' as const :
                   refVol < 40 ? 'low' as const :
                   refVol < 80 ? 'medium' as const : 'high' as const;

    // Raw model probabilities — Student-t is primary, normal is fallback
    const rawExtortion = this.calcDropProbStudentT(5, THRESHOLDS.extortion);
    const rawArms = this.calcDropProbStudentT(30, THRESHOLDS.arms);
    const rawDrug = this.calcDropProbStudentT(90, THRESHOLDS.drug);

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

    // --- Composite danger score (0-100) ---
    let danger = 0;

    // Vol regime (0-35)
    const refVol = vol.vol30m ?? vol.vol5m ?? 0;
    if (refVol > 120) danger += 35;
    else if (refVol > 80) danger += 25;
    else if (refVol > 60) danger += 18;
    else if (refVol > 40) danger += 10;
    else danger += 3;

    // CVD pressure (0-20)
    if (cvd5m < 0) {
      const pressure = Math.min(1, Math.abs(cvd5m) / 5_000_000);
      danger += pressure * 20;
    }

    // OB imbalance (0-12)
    if (obImbalance < 0) {
      danger += Math.min(1, Math.abs(obImbalance) / 0.5) * 12;
    }

    // Liq cascade (0-15)
    const cascadeScore = { LOW: 0, ELEVATED: 5, HIGH: 10, CRITICAL: 15 };
    danger += cascadeScore[liq.cascadeRisk];

    // Funding heat (0-5)
    danger += fundingHeat * 5;

    // CVD divergence (0-8)
    danger += cvdDivergence * 8;

    // IV/RV spread (0-5)
    danger += Math.min(1, ivrvSpread / 0.15) * 5;

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

    return {
      ethPrice: this.ethPrice,
      ethPriceStart: this.ethPriceStart,
      volatility: vol,
      scores,
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
