// ============================================================
// Phase 4: Backtesting Engine
// Replays historical 1-min klines through the volatility model
// and checks whether predicted probabilities match reality.
// ============================================================

import type { Kline } from './fetcher';
import { logger } from '../logger';

// Same thresholds as live engine
const THRESHOLDS = {
  extortion: { dropPct: 0.17, windowMin: 5 },
  arms: { dropPct: 0.71, windowMin: 30 },
  drug: { dropPct: 2.0, windowMin: 90 },
};

// Normal CDF approximation (same as live engine)
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327;
  const p = d * Math.exp(-x * x / 2) * t *
    (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Calculate realized vol from returns (annualized %)
function calcVol(returns: number[]): number | null {
  if (returns.length < 3) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  return stdDev * Math.sqrt(525600) * 100;
}

// Predict P(drop > threshold) using vol model
function predictDropProb(volAnnualized: number, windowMin: number, thresholdPct: number): number {
  const volPerMin = (volAnnualized / 100) / Math.sqrt(525600);
  const windowVol = volPerMin * Math.sqrt(windowMin);
  const threshold = thresholdPct / 100;
  const z = threshold / windowVol;
  return 1 - normCdf(z);
}

// Check if ETH actually dropped > threshold during window
function didDrop(klines: Kline[], startIdx: number, windowMin: number, thresholdPct: number): boolean {
  const startPrice = klines[startIdx].close;
  const threshold = thresholdPct / 100;
  const endIdx = Math.min(startIdx + windowMin, klines.length);

  for (let i = startIdx + 1; i < endIdx; i++) {
    // Check candle low — if low dropped below threshold, operation fails
    const maxDrop = (startPrice - klines[i].low) / startPrice;
    if (maxDrop >= threshold) return true;
  }
  return false;
}

export interface BacktestConfig {
  volWindow: number;       // minutes of history for vol calc (default 30)
  sampleEvery: number;     // simulate operation every N minutes (default 5)
}

export interface OperationResult {
  timestamp: number;
  price: number;
  volAnnualized: number;
  predicted: number;       // P(fail) from model
  actual: boolean;         // did it actually fail?
  regime: 'low' | 'medium' | 'high';
}

export interface CalibrationBucket {
  bucketLabel: string;
  predRange: [number, number];
  count: number;
  failures: number;
  actualRate: number;
  avgPredicted: number;
  calibrationError: number;  // |actual - predicted|
}

export interface BacktestResults {
  operation: string;
  totalSimulations: number;
  totalFailures: number;
  overallFailRate: number;
  overallAvgPredicted: number;
  calibration: CalibrationBucket[];
  byRegime: {
    regime: string;
    count: number;
    failures: number;
    failRate: number;
    avgPredicted: number;
  }[];
  brierScore: number;
  hourlyPattern: { hour: number; count: number; failRate: number }[];
}

export function runBacktest(
  klines: Kline[],
  opType: keyof typeof THRESHOLDS,
  cfg: BacktestConfig = { volWindow: 30, sampleEvery: 5 }
): BacktestResults {
  const { dropPct, windowMin } = THRESHOLDS[opType];
  const results: OperationResult[] = [];

  // Build 1-min log returns
  const returns: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    returns.push(Math.log(klines[i].close / klines[i - 1].close));
  }

  // Need enough history for vol window AND enough future for operation window
  const startIdx = cfg.volWindow + 1;
  const endIdx = klines.length - windowMin;

  logger.info(`[Backtest] ${opType}: simulating from candle ${startIdx} to ${endIdx}, step ${cfg.sampleEvery}`);

  for (let i = startIdx; i < endIdx; i += cfg.sampleEvery) {
    // Get trailing vol
    const trailingReturns = returns.slice(i - cfg.volWindow, i);
    const vol = calcVol(trailingReturns);
    if (vol === null) continue;

    // Predict failure probability
    const predicted = predictDropProb(vol, windowMin, dropPct);

    // Check actual outcome
    const actual = didDrop(klines, i, windowMin, dropPct);

    // Classify regime
    const regime = vol < 40 ? 'low' as const : vol < 80 ? 'medium' as const : 'high' as const;

    results.push({
      timestamp: klines[i].openTime,
      price: klines[i].close,
      volAnnualized: vol,
      predicted,
      actual,
      regime,
    });
  }

  // === Analyze results ===

  const totalSimulations = results.length;
  const totalFailures = results.filter(r => r.actual).length;
  const overallFailRate = totalFailures / totalSimulations;
  const overallAvgPredicted = results.reduce((s, r) => s + r.predicted, 0) / totalSimulations;

  // Calibration buckets
  const bucketEdges = [0, 0.02, 0.05, 0.10, 0.20, 0.35, 0.50, 1.0];
  const calibration: CalibrationBucket[] = [];

  for (let b = 0; b < bucketEdges.length - 1; b++) {
    const lo = bucketEdges[b];
    const hi = bucketEdges[b + 1];
    const inBucket = results.filter(r => r.predicted >= lo && r.predicted < hi);
    if (inBucket.length === 0) continue;

    const failures = inBucket.filter(r => r.actual).length;
    const actualRate = failures / inBucket.length;
    const avgPred = inBucket.reduce((s, r) => s + r.predicted, 0) / inBucket.length;

    calibration.push({
      bucketLabel: `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`,
      predRange: [lo, hi],
      count: inBucket.length,
      failures,
      actualRate,
      avgPredicted: avgPred,
      calibrationError: Math.abs(actualRate - avgPred),
    });
  }

  // By regime
  const regimes = ['low', 'medium', 'high'] as const;
  const byRegime = regimes.map(regime => {
    const inRegime = results.filter(r => r.regime === regime);
    if (inRegime.length === 0) return { regime, count: 0, failures: 0, failRate: 0, avgPredicted: 0 };
    const failures = inRegime.filter(r => r.actual).length;
    return {
      regime,
      count: inRegime.length,
      failures,
      failRate: failures / inRegime.length,
      avgPredicted: inRegime.reduce((s, r) => s + r.predicted, 0) / inRegime.length,
    };
  });

  // Brier score (lower = better calibrated, 0 = perfect)
  const brierScore = results.reduce((s, r) => {
    const actual = r.actual ? 1 : 0;
    return s + (r.predicted - actual) ** 2;
  }, 0) / totalSimulations;

  // Hourly pattern
  const hourBuckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, failures: 0 }));
  for (const r of results) {
    const hour = new Date(r.timestamp).getUTCHours();
    hourBuckets[hour].count++;
    if (r.actual) hourBuckets[hour].failures++;
  }
  const hourlyPattern = hourBuckets.map(b => ({
    hour: b.hour,
    count: b.count,
    failRate: b.count > 0 ? b.failures / b.count : 0,
  }));

  return {
    operation: opType,
    totalSimulations,
    totalFailures,
    overallFailRate,
    overallAvgPredicted,
    calibration,
    byRegime,
    brierScore,
    hourlyPattern,
  };
}

// Pretty print results
export function printResults(r: BacktestResults) {
  logger.info('\n' + '='.repeat(60));
  logger.info(`  BACKTEST: ${r.operation.toUpperCase()}`);
  logger.info('='.repeat(60));
  logger.info(`  Simulations: ${r.totalSimulations.toLocaleString()}`);
  logger.info(`  Failures:    ${r.totalFailures.toLocaleString()} (${(r.overallFailRate * 100).toFixed(2)}%)`);
  logger.info(`  Avg Predicted P(fail): ${(r.overallAvgPredicted * 100).toFixed(2)}%`);
  logger.info(`  Brier Score: ${r.brierScore.toFixed(4)} (lower = better, <0.1 = good)`);

  logger.info('\n  CALIBRATION (predicted vs actual failure rate):');
  logger.info('  ' + '-'.repeat(56));
  logger.info('  Pred Range   | Count   | Actual   | Predicted | Error');
  logger.info('  ' + '-'.repeat(56));
  for (const b of r.calibration) {
    logger.info(
      `  ${b.bucketLabel.padEnd(12)} | ${String(b.count).padStart(6)} | ` +
      `${(b.actualRate * 100).toFixed(1).padStart(6)}%  | ` +
      `${(b.avgPredicted * 100).toFixed(1).padStart(6)}%   | ` +
      `${(b.calibrationError * 100).toFixed(1).padStart(5)}%`
    );
  }

  logger.info('\n  BY VOLATILITY REGIME:');
  logger.info('  ' + '-'.repeat(50));
  for (const rg of r.byRegime) {
    if (rg.count === 0) continue;
    logger.info(
      `  ${rg.regime.toUpperCase().padEnd(8)} | ${String(rg.count).padStart(6)} ops | ` +
      `Fail: ${(rg.failRate * 100).toFixed(1)}% | Pred: ${(rg.avgPredicted * 100).toFixed(1)}%`
    );
  }

  logger.info('\n  HOURLY FAILURE PATTERN (UTC):');
  logger.info('  ' + '-'.repeat(50));
  const maxRate = Math.max(...r.hourlyPattern.map(h => h.failRate));
  for (const h of r.hourlyPattern) {
    if (h.count === 0) continue;
    const barLen = maxRate > 0 ? Math.round((h.failRate / maxRate) * 20) : 0;
    const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
    logger.info(
      `  ${String(h.hour).padStart(2)}:00 | ${bar} | ${(h.failRate * 100).toFixed(1)}% (n=${h.count})`
    );
  }
}
