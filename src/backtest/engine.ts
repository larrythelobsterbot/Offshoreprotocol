// ============================================================
// Phase 4: Backtesting Engine
// Replays historical 1-min klines through the volatility model
// and checks whether predicted probabilities match reality.
//
// Uses the same Student-t drop-probability function as the live
// engine (src/engine/distributions.ts) so the calibration tables
// derived here are valid for the production raw distribution.
// ============================================================

import type { Kline } from './fetcher';
import { logger } from '../logger';
import { dropProbStudentT } from '../engine/distributions';
import { calibrateProb } from '../engine/calibration';
import { config } from '../config';

// Canonical game thresholds from offshoreprotocol.fun/llms.txt
const THRESHOLDS = {
  extortion: { dropPct: 0.039, windowMin: 5 },
  arms: { dropPct: 0.176, windowMin: 30 },
  drug: { dropPct: 0.518, windowMin: 90 },
};

// Calculate realized vol from returns (annualized %)
function calcVol(returns: number[]): number | null {
  if (returns.length < 3) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  return stdDev * Math.sqrt(525600) * 100;
}

// Predict P(drop > threshold) using same Student-t model as live engine
function predictDropProb(volAnnualized: number, windowMin: number, thresholdPct: number): number {
  return dropProbStudentT(volAnnualized, windowMin, thresholdPct, config.studentTDf);
}

// Check if ETH actually dropped > threshold during window
function didDrop(klines: Kline[], startIdx: number, windowMin: number, thresholdPct: number): boolean {
  const startPrice = klines[startIdx].close;
  const threshold = thresholdPct / 100;
  const endIdx = Math.min(startIdx + windowMin, klines.length);

  for (let i = startIdx + 1; i < endIdx; i++) {
    const maxDrop = (startPrice - klines[i].low) / startPrice;
    if (maxDrop >= threshold) return true;
  }
  return false;
}

export interface BacktestConfig {
  volWindow: number;       // minutes of history for vol calc (default 30)
  sampleEvery: number;     // simulate operation every N minutes (default 5)
  applyCalibration?: boolean; // also compute calibrated Brier alongside raw
}

export interface OperationResult {
  timestamp: number;
  price: number;
  volAnnualized: number;
  predicted: number;       // raw P(fail) from Student-t model
  calibrated?: number;     // calibrated P(fail), if requested
  actual: boolean;
  regime: 'low' | 'medium' | 'high';
}

export interface CalibrationBucket {
  bucketLabel: string;
  predRange: [number, number];
  count: number;
  failures: number;
  actualRate: number;
  avgPredicted: number;
  calibrationError: number;
}

export interface BacktestResults {
  operation: string;
  thresholdPct: number;
  windowMin: number;
  totalSimulations: number;
  totalFailures: number;
  overallFailRate: number;
  overallAvgPredicted: number;
  overallAvgCalibrated?: number;
  calibration: CalibrationBucket[];
  byRegime: {
    regime: string;
    count: number;
    failures: number;
    failRate: number;
    avgPredicted: number;
  }[];
  brierScore: number;             // raw Student-t predictions
  brierScoreCalibrated?: number;  // after calibrateProb()
  hourlyPattern: { hour: number; count: number; failRate: number; failures: number }[];
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

  const startIdx = cfg.volWindow + 1;
  const endIdx = klines.length - windowMin;

  logger.info({ opType, dropPct, windowMin, startIdx, endIdx, step: cfg.sampleEvery }, `[Backtest] ${opType}: simulating`);

  for (let i = startIdx; i < endIdx; i += cfg.sampleEvery) {
    const trailingReturns = returns.slice(i - cfg.volWindow, i);
    const vol = calcVol(trailingReturns);
    if (vol === null) continue;

    const predicted = predictDropProb(vol, windowMin, dropPct);
    const actual = didDrop(klines, i, windowMin, dropPct);

    let calibrated: number | undefined;
    if (cfg.applyCalibration) {
      const utcHour = new Date(klines[i].openTime).getUTCHours();
      calibrated = calibrateProb(predicted, opType, utcHour);
    }

    const regime = vol < 40 ? 'low' as const : vol < 80 ? 'medium' as const : 'high' as const;

    results.push({
      timestamp: klines[i].openTime,
      price: klines[i].close,
      volAnnualized: vol,
      predicted,
      calibrated,
      actual,
      regime,
    });
  }

  const totalSimulations = results.length;
  const totalFailures = results.filter(r => r.actual).length;
  const overallFailRate = totalFailures / totalSimulations;
  const overallAvgPredicted = results.reduce((s, r) => s + r.predicted, 0) / totalSimulations;
  const overallAvgCalibrated = cfg.applyCalibration
    ? results.reduce((s, r) => s + (r.calibrated ?? 0), 0) / totalSimulations
    : undefined;

  // Calibration buckets — fine resolution in the 0-50% band where the
  // Student-t model concentrates predictions under canonical thresholds.
  // Coarser at the high end where the predictor rarely produces values.
  const bucketEdges = [
    0, 0.025, 0.05, 0.075, 0.10, 0.125, 0.15, 0.20,
    0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.60, 0.75, 1.0001,
  ];
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
      bucketLabel: `${(lo * 100).toFixed(0)}-${(Math.min(hi, 1) * 100).toFixed(0)}%`,
      predRange: [lo, Math.min(hi, 1)],
      count: inBucket.length,
      failures,
      actualRate,
      avgPredicted: avgPred,
      calibrationError: Math.abs(actualRate - avgPred),
    });
  }

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

  const brierScore = results.reduce((s, r) => {
    const actual = r.actual ? 1 : 0;
    return s + (r.predicted - actual) ** 2;
  }, 0) / totalSimulations;

  const brierScoreCalibrated = cfg.applyCalibration
    ? results.reduce((s, r) => {
        const actual = r.actual ? 1 : 0;
        return s + ((r.calibrated ?? 0) - actual) ** 2;
      }, 0) / totalSimulations
    : undefined;

  const hourBuckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, failures: 0 }));
  for (const r of results) {
    const hour = new Date(r.timestamp).getUTCHours();
    hourBuckets[hour].count++;
    if (r.actual) hourBuckets[hour].failures++;
  }
  const hourlyPattern = hourBuckets.map(b => ({
    hour: b.hour,
    count: b.count,
    failures: b.failures,
    failRate: b.count > 0 ? b.failures / b.count : 0,
  }));

  return {
    operation: opType,
    thresholdPct: dropPct,
    windowMin,
    totalSimulations,
    totalFailures,
    overallFailRate,
    overallAvgPredicted,
    overallAvgCalibrated,
    calibration,
    byRegime,
    brierScore,
    brierScoreCalibrated,
    hourlyPattern,
  };
}

export function printResults(r: BacktestResults) {
  logger.info('\n' + '='.repeat(60));
  logger.info(`  BACKTEST: ${r.operation.toUpperCase()}  (drop ${r.thresholdPct}% in ${r.windowMin}m)`);
  logger.info('='.repeat(60));
  logger.info(`  Simulations: ${r.totalSimulations.toLocaleString()}`);
  logger.info(`  Failures:    ${r.totalFailures.toLocaleString()} (${(r.overallFailRate * 100).toFixed(2)}%)`);
  logger.info(`  Avg Raw Predicted P(fail):        ${(r.overallAvgPredicted * 100).toFixed(2)}%`);
  if (r.overallAvgCalibrated !== undefined) {
    logger.info(`  Avg Calibrated Predicted P(fail): ${(r.overallAvgCalibrated * 100).toFixed(2)}%`);
  }
  logger.info(`  Brier Score (raw):        ${r.brierScore.toFixed(4)}`);
  if (r.brierScoreCalibrated !== undefined) {
    const delta = r.brierScoreCalibrated - r.brierScore;
    const arrow = delta < 0 ? 'better' : delta > 0 ? 'WORSE' : 'same';
    logger.info(`  Brier Score (calibrated): ${r.brierScoreCalibrated.toFixed(4)}  (${arrow}, Δ=${delta.toFixed(4)})`);
  }

  logger.info('  CALIBRATION (raw predicted vs actual failure rate):');
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

  logger.info('  BY VOLATILITY REGIME:');
  logger.info('  ' + '-'.repeat(50));
  for (const rg of r.byRegime) {
    if (rg.count === 0) continue;
    logger.info(
      `  ${rg.regime.toUpperCase().padEnd(8)} | ${String(rg.count).padStart(6)} ops | ` +
      `Fail: ${(rg.failRate * 100).toFixed(1)}% | Pred: ${(rg.avgPredicted * 100).toFixed(1)}%`
    );
  }

  logger.info('  HOURLY FAILURE PATTERN (UTC):');
  logger.info('  ' + '-'.repeat(50));
  const maxRate = Math.max(...r.hourlyPattern.map(h => h.failRate));
  for (const h of r.hourlyPattern) {
    if (h.count === 0) continue;
    const barLen = maxRate > 0 ? Math.round((h.failRate / maxRate) * 20) : 0;
    const bar = '#'.repeat(barLen) + '.'.repeat(20 - barLen);
    logger.info(
      `  ${String(h.hour).padStart(2)}:00 | ${bar} | ${(h.failRate * 100).toFixed(1)}% (n=${h.count})`
    );
  }
}
