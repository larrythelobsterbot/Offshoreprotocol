// ============================================================
// Phase 4: Backtest Runner
// Usage: npx tsx src/backtest/run.ts [days]
// Example: npx tsx src/backtest/run.ts 90
// ============================================================

import { fetchKlines } from './fetcher';
import { runBacktest, printResults } from './engine';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

async function main() {
  const days = parseInt(process.argv[2] || '30');

  console.log('='.repeat(60));
  console.log('  OFFSHORE OPS TERMINAL — PHASE 4 BACKTEST');
  console.log('='.repeat(60));
  console.log(`  Period: ${days} days of 1-min ETH/USDT candles`);
  console.log(`  Source: Binance Futures (free API)`);
  console.log('');

  // Check for cached data
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const cacheFile = path.join(DATA_DIR, `klines_${days}d.json`);
  let klines;

  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600_000;
    console.log(`  Found cached data (${ageHours.toFixed(1)}h old)`);

    if (ageHours < 24) {
      console.log('  Using cache. Delete file to re-download.\n');
      klines = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    } else {
      console.log('  Cache stale, re-downloading...\n');
      klines = await fetchKlines(days, (pct, count) => {
        process.stdout.write(`\r  Progress: ${pct.toFixed(1)}% (${count} candles)`);
      });
      console.log('');
      fs.writeFileSync(cacheFile, JSON.stringify(klines));
    }
  } else {
    console.log('  Downloading historical data...\n');
    klines = await fetchKlines(days, (pct, count) => {
      process.stdout.write(`\r  Progress: ${pct.toFixed(1)}% (${count} candles)`);
    });
    console.log('');
    fs.writeFileSync(cacheFile, JSON.stringify(klines));
    console.log(`  Cached to ${cacheFile}`);
  }

  console.log(`  Total candles: ${klines.length.toLocaleString()}`);
  const firstDate = new Date(klines[0].openTime).toISOString().split('T')[0];
  const lastDate = new Date(klines[klines.length - 1].openTime).toISOString().split('T')[0];
  console.log(`  Range: ${firstDate} to ${lastDate}`);

  // Run backtests for all three operation types
  const configs = [
    { op: 'extortion' as const, volWindow: 30, sampleEvery: 1 },
    { op: 'arms' as const, volWindow: 30, sampleEvery: 5 },
    { op: 'drug' as const, volWindow: 30, sampleEvery: 10 },
  ];

  const allResults = [];

  for (const c of configs) {
    console.log(`\n  Running ${c.op} backtest...`);
    const results = runBacktest(klines, c.op, {
      volWindow: c.volWindow,
      sampleEvery: c.sampleEvery,
    });
    printResults(results);
    allResults.push(results);
  }

  // === Summary comparison ===
  console.log('\n' + '='.repeat(60));
  console.log('  SUMMARY — MODEL CALIBRATION');
  console.log('='.repeat(60));
  console.log('');
  console.log('  Operation    | Simulations | Fail Rate | Avg Pred  | Brier');
  console.log('  ' + '-'.repeat(58));
  for (const r of allResults) {
    console.log(
      `  ${r.operation.padEnd(12)} | ${String(r.totalSimulations).padStart(10)} | ` +
      `${(r.overallFailRate * 100).toFixed(1).padStart(7)}%  | ` +
      `${(r.overallAvgPredicted * 100).toFixed(1).padStart(6)}%   | ` +
      `${r.brierScore.toFixed(4)}`
    );
  }

  console.log('\n  INTERPRETATION:');
  console.log('  Brier < 0.05 = excellent calibration');
  console.log('  Brier 0.05-0.10 = good, usable for decisions');
  console.log('  Brier 0.10-0.20 = mediocre, use with caution');
  console.log('  Brier > 0.20 = poor, model needs re-weighting');

  // Check if model is systematically over/under-predicting
  for (const r of allResults) {
    const ratio = r.overallAvgPredicted / (r.overallFailRate || 0.001);
    if (ratio > 1.5) {
      console.log(`\n  ⚠ ${r.operation.toUpperCase()}: Model OVER-predicts failure by ${((ratio - 1) * 100).toFixed(0)}%.`);
      console.log(`    Operations are safer than the dashboard suggests.`);
      console.log(`    Consider lowering vol sensitivity or penalty weights.`);
    } else if (ratio < 0.67) {
      console.log(`\n  ⚠ ${r.operation.toUpperCase()}: Model UNDER-predicts failure by ${((1 - ratio) * 100).toFixed(0)}%.`);
      console.log(`    Operations are riskier than shown. Increase safety margins.`);
    } else {
      console.log(`\n  ✓ ${r.operation.toUpperCase()}: Model is reasonably calibrated (pred/actual ratio: ${ratio.toFixed(2)})`);
    }
  }

  // Save full results as JSON
  const resultsFile = path.join(DATA_DIR, `backtest_results_${days}d.json`);
  fs.writeFileSync(resultsFile, JSON.stringify(allResults, null, 2));
  console.log(`\n  Full results saved to ${resultsFile}`);

  console.log('\n' + '='.repeat(60));
  console.log('  BACKTEST COMPLETE');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
