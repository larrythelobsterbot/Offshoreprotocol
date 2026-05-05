// ============================================================
// Phase 4: Backtest Runner
// Usage: npx tsx src/backtest/run.ts [days]
// Example: npx tsx src/backtest/run.ts 90
// ============================================================

import { fetchKlines } from './fetcher';
import { runBacktest, printResults } from './engine';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

const DATA_DIR = path.join(process.cwd(), 'data');

async function main() {
  const days = parseInt(process.argv[2] || '30');

  logger.info('='.repeat(60));
  logger.info('  OFFSHORE OPS TERMINAL — PHASE 4 BACKTEST');
  logger.info('='.repeat(60));
  logger.info(`  Period: ${days} days of 1-min ETH/USDT candles`);
  logger.info(`  Source: Binance Futures (free API)`);
  logger.info('');

  // Check for cached data
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const cacheFile = path.join(DATA_DIR, `klines_${days}d.json`);
  let klines;

  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600_000;
    logger.info(`  Found cached data (${ageHours.toFixed(1)}h old)`);

    if (ageHours < 24) {
      logger.info('  Using cache. Delete file to re-download.');
      klines = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    } else {
      logger.info('  Cache stale, re-downloading...');
      klines = await fetchKlines(days, (pct, count) => {
        process.stdout.write(`\r  Progress: ${pct.toFixed(1)}% (${count} candles)`);
      });
      logger.info('');
      fs.writeFileSync(cacheFile, JSON.stringify(klines));
    }
  } else {
    logger.info('  Downloading historical data...');
    klines = await fetchKlines(days, (pct, count) => {
      process.stdout.write(`\r  Progress: ${pct.toFixed(1)}% (${count} candles)`);
    });
    logger.info('');
    fs.writeFileSync(cacheFile, JSON.stringify(klines));
    logger.info(`  Cached to ${cacheFile}`);
  }

  logger.info(`  Total candles: ${klines.length.toLocaleString()}`);
  const firstDate = new Date(klines[0].openTime).toISOString().split('T')[0];
  const lastDate = new Date(klines[klines.length - 1].openTime).toISOString().split('T')[0];
  logger.info(`  Range: ${firstDate} to ${lastDate}`);

  // Run backtests for all three operation types
  const configs = [
    { op: 'extortion' as const, volWindow: 30, sampleEvery: 1 },
    { op: 'arms' as const, volWindow: 30, sampleEvery: 5 },
    { op: 'drug' as const, volWindow: 30, sampleEvery: 10 },
  ];

  const allResults = [];

  // CLI flag: pass --calibrated as a 3rd arg to enable calibration in the
  // backtest. With --calibrated the run also computes a calibrated Brier
  // score for direct comparison vs raw.
  const applyCalibration = process.argv.includes('--calibrated');
  if (applyCalibration) logger.info('  Calibration enabled — computing calibrated Brier alongside raw.');

  for (const c of configs) {
    logger.info(`  Running ${c.op} backtest...`);
    const results = runBacktest(klines, c.op, {
      volWindow: c.volWindow,
      sampleEvery: c.sampleEvery,
      applyCalibration,
    });
    printResults(results);
    allResults.push(results);
  }

  // === Summary comparison ===
  logger.info('\n' + '='.repeat(60));
  logger.info('  SUMMARY — MODEL CALIBRATION');
  logger.info('='.repeat(60));
  logger.info('');
  if (applyCalibration) {
    logger.info('  Operation    | Sims     | Fail %  | Raw Pred | Cal Pred | Brier Raw | Brier Cal | Δ');
    logger.info('  ' + '-'.repeat(96));
    for (const r of allResults) {
      const dRel = r.brierScoreCalibrated !== undefined
        ? ((r.brierScoreCalibrated - r.brierScore) / r.brierScore) * 100
        : 0;
      const arrow = dRel < -1 ? 'better' : dRel > 1 ? 'WORSE' : 'same';
      logger.info(
        `  ${r.operation.padEnd(12)} | ${String(r.totalSimulations).padStart(7)} | ` +
        `${(r.overallFailRate * 100).toFixed(1).padStart(5)}% | ` +
        `${(r.overallAvgPredicted * 100).toFixed(1).padStart(6)}% | ` +
        `${((r.overallAvgCalibrated ?? 0) * 100).toFixed(1).padStart(6)}% | ` +
        `${r.brierScore.toFixed(4).padStart(7)}   | ` +
        `${(r.brierScoreCalibrated ?? 0).toFixed(4).padStart(7)}   | ` +
        `${dRel.toFixed(1).padStart(5)}% ${arrow}`,
      );
    }
  } else {
    logger.info('  Operation    | Simulations | Fail Rate | Avg Pred  | Brier');
    logger.info('  ' + '-'.repeat(58));
    for (const r of allResults) {
      logger.info(
        `  ${r.operation.padEnd(12)} | ${String(r.totalSimulations).padStart(10)} | ` +
        `${(r.overallFailRate * 100).toFixed(1).padStart(7)}%  | ` +
        `${(r.overallAvgPredicted * 100).toFixed(1).padStart(6)}%   | ` +
        `${r.brierScore.toFixed(4)}`
      );
    }
  }

  logger.info('  INTERPRETATION:');
  logger.info('  Brier < 0.05 = excellent calibration');
  logger.info('  Brier 0.05-0.10 = good, usable for decisions');
  logger.info('  Brier 0.10-0.20 = mediocre, use with caution');
  logger.info('  Brier > 0.20 = poor, model needs re-weighting');

  // Check if model is systematically over/under-predicting
  for (const r of allResults) {
    const ratio = r.overallAvgPredicted / (r.overallFailRate || 0.001);
    if (ratio > 1.5) {
      logger.warn(`  ${r.operation.toUpperCase()}: Model OVER-predicts failure by ${((ratio - 1) * 100).toFixed(0)}%.`);
      logger.warn(`    Operations are safer than the dashboard suggests.`);
      logger.warn(`    Consider lowering vol sensitivity or penalty weights.`);
    } else if (ratio < 0.67) {
      logger.warn(`  ${r.operation.toUpperCase()}: Model UNDER-predicts failure by ${((1 - ratio) * 100).toFixed(0)}%.`);
      logger.warn(`    Operations are riskier than shown. Increase safety margins.`);
    } else {
      logger.info(`  ${r.operation.toUpperCase()}: Model is reasonably calibrated (pred/actual ratio: ${ratio.toFixed(2)})`);
    }
  }

  // Save full results as JSON
  const resultsFile = path.join(DATA_DIR, `backtest_results_${days}d.json`);
  fs.writeFileSync(resultsFile, JSON.stringify(allResults, null, 2));
  logger.info(`  Full results saved to ${resultsFile}`);

  logger.info('\n' + '='.repeat(60));
  logger.info('  BACKTEST COMPLETE');
  logger.info('='.repeat(60));
}

main().catch(err => {
  logger.error({ err }, 'Backtest failed');
  process.exit(1);
});
