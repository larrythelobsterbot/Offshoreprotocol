// ============================================================
// Probability Calibration
// 180-day backtest (2025-11-05 to 2026-05-05), 259,459 1-min candles
// Source: Coinbase ETH-USD spot (full history), Hyperliquid (recent only)
// Thresholds: canonical from offshoreprotocol.fun/llms.txt
//   Extortion 0.039% / 5m, Arms 0.176% / 30m, Drug 0.518% / 90m
//
// The Student-t model under-predicts failure at these tight
// thresholds because the model assumes Student-t marginals while
// realized 1-min ETH returns have additional microstructure noise
// (bid-ask flicker, isolated wicks) that crosses 0.039% routinely.
// This module corrects raw predictions using:
// 1. Piecewise linear interpolation from PAVA-monotonic backtest
//    calibration tables (low-count buckets filtered, n>=50)
// 2. Hourly adjustment factors (14-17 UTC danger band, mild)
//
// Regenerate via: npx tsx src/backtest/build-calibration.ts 180
// ============================================================

// Calibration points: [rawPredicted (Student-t df=4), observedActual]
const CALIBRATION_POINTS = {
  extortion: [
    [0.000, 0.201],  // floor
    [0.176, 0.201],  // w=736
    [0.230, 0.209],  // w=2406
    [0.278, 0.292],  // w=6390
    [0.329, 0.404],  // w=15270
    [0.380, 0.553],  // w=46071
    [0.428, 0.697],  // w=118711
    [0.464, 0.821],  // w=69820
    [1.000, 1.000],  // anchor
  ],
  arms: [
    [0.000, 0.099],  // floor
    [0.081, 0.099],  // w=302
    [0.114, 0.108],  // w=371
    [0.139, 0.120],  // w=527
    [0.177, 0.164],  // w=1460
    [0.228, 0.293],  // w=2740
    [0.278, 0.398],  // w=5183
    [0.327, 0.505],  // w=9407
    [0.376, 0.600],  // w=15048
    [0.423, 0.710],  // w=13739
    [0.461, 0.822],  // w=3079
    [1.000, 1.000],  // anchor
  ],
  drug: [
    [0.000, 0.020],  // floor
    [0.017, 0.020],  // w=99
    [0.038, 0.049],  // w=390
    [0.076, 0.093],  // w=1031
    [0.113, 0.131],  // w=724
    [0.138, 0.188],  // w=913
    [0.177, 0.242],  // w=2511
    [0.227, 0.320],  // w=3530
    [0.276, 0.386],  // w=4639
    [0.325, 0.468],  // w=5301
    [0.373, 0.544],  // w=4257
    [0.421, 0.670],  // w=2359
    [0.459, 0.783],  // w=180
    [1.000, 1.000],  // anchor
  ],
};

// Hourly multipliers derived from 180d backtest hourly fail-rate / overall.
// Under canonical thresholds the diurnal pattern is muted (1.0±0.15) because
// base failure rate is high; the old wide-threshold tables had 2-3x swings.
const HOURLY_MULTIPLIERS: Record<string, number[]> = {
  extortion: [
    1.02, 1.01, 1.00, 0.96, 0.92, 0.93,  // 00-05 UTC
    0.91, 0.92, 0.95, 0.93, 0.93, 0.93,  // 06-11 UTC
    0.98, 1.05, 1.13, 1.14, 1.13, 1.08,  // 12-17 UTC
    1.07, 1.03, 1.01, 0.97, 1.00, 0.99,  // 18-23 UTC
  ],
  arms: [
    1.02, 1.03, 1.00, 0.87, 0.88, 0.91,  // 00-05 UTC
    0.85, 0.86, 0.93, 0.89, 0.86, 0.87,  // 06-11 UTC
    1.00, 1.13, 1.28, 1.18, 1.20, 1.13,  // 12-17 UTC
    1.10, 1.03, 1.00, 0.96, 1.03, 1.00,  // 18-23 UTC
  ],
  drug: [
    0.91, 1.00, 0.92, 0.84, 0.89, 0.83,  // 00-05 UTC
    0.85, 0.88, 0.81, 0.85, 0.80, 0.95,  // 06-11 UTC
    1.14, 1.44, 1.46, 1.26, 1.25, 1.21,  // 12-17 UTC
    1.06, 0.95, 0.92, 0.90, 1.00, 0.91,  // 18-23 UTC
  ],
};

// Piecewise linear interpolation
function interpolate(points: number[][], rawProb: number): number {
  if (rawProb <= points[0][0]) return points[0][1];
  if (rawProb >= points[points.length - 1][0]) return points[points.length - 1][1];

  for (let i = 1; i < points.length; i++) {
    if (rawProb <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      const t = (rawProb - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return rawProb;
}

/**
 * Calibrate a raw model probability to match observed historical rates.
 * @param rawProb - Raw P(fail) from normal CDF model (0-1)
 * @param opType - Operation type
 * @param utcHour - Current UTC hour (0-23), optional for hourly adjustment
 * @returns Calibrated P(fail) (0-1)
 */
export function calibrateProb(
  rawProb: number,
  opType: 'extortion' | 'arms' | 'drug',
  utcHour?: number
): number {
  // Step 1: Piecewise calibration from backtest data
  const points = CALIBRATION_POINTS[opType];
  let calibrated = interpolate(points, rawProb);

  // Step 2: Hourly adjustment if hour provided
  if (utcHour !== undefined && utcHour >= 0 && utcHour < 24) {
    const multiplier = HOURLY_MULTIPLIERS[opType][utcHour];
    calibrated = calibrated * multiplier;
  }

  // Clamp to [0, 1]
  return Math.min(1, Math.max(0, calibrated));
}

/**
 * Get the current hourly risk level for display purposes
 * @returns 'safe' | 'normal' | 'danger'
 */
export function getHourlyRiskLevel(utcHour: number): 'safe' | 'normal' | 'danger' {
  // Based on consistent patterns across all operations
  if ((utcHour >= 3 && utcHour <= 5) || (utcHour >= 9 && utcHour <= 11)) return 'safe';
  if (utcHour >= 14 && utcHour <= 18) return 'danger';
  return 'normal';
}

/**
 * Get suggested operation for current conditions.
 *
 * Thresholds are scaled to the calibrated probability distribution
 * for canonical game thresholds (Ext 67% avg fail, Arms 56%, Drug 40%).
 * "Good" windows are notably below those averages; nothing is risk-free.
 *
 * Operation selection also has to account for fire rate and payout
 * (12 ops/hr extortion, 2 ops/hr arms, ~0.67 ops/hr drug — all paying
 * 100-130 $DIRTY), which favors extortion's expected $/hour heavily
 * despite higher per-op failure rate. The thresholds below pick the
 * highest fire-rate op whose calibrated P(fail) is still better than
 * its category-average baseline.
 */
export function getSuggestedOp(
  calibratedProbs: { extortion: number; arms: number; drug: number },
  utcHour: number
): string {
  const hourRisk = getHourlyRiskLevel(utcHour);

  // Average calibrated baselines (180d backtest):
  //   Extortion ~0.67, Arms ~0.56, Drug ~0.40
  // "Good" = roughly 15+ percentage points under baseline.
  const EXT_GOOD = 0.50;
  const EXT_OK   = 0.60;
  const ARM_GOOD = 0.40;
  const ARM_OK   = 0.50;
  const DRUG_GOOD = 0.25;
  const DRUG_OK   = 0.35;

  if (hourRisk === 'danger') {
    if (calibratedProbs.drug < DRUG_GOOD) return 'Drug Deal only (danger hours)';
    if (calibratedProbs.drug < DRUG_OK)   return 'Drug Deal cautious (danger hours)';
    return 'AVOID ALL — danger hours + elevated risk';
  }

  // Prefer highest fire-rate op whose calibrated P(fail) is in a "good" window.
  if (calibratedProbs.extortion < EXT_GOOD) return 'Extortion (good window)';
  if (calibratedProbs.arms      < ARM_GOOD) return 'Arms Deal (good window)';
  if (calibratedProbs.drug      < DRUG_GOOD) return 'Drug Deal (good window)';

  if (calibratedProbs.extortion < EXT_OK) return 'Extortion (acceptable window)';
  if (calibratedProbs.arms      < ARM_OK) return 'Arms Deal (acceptable window)';
  if (calibratedProbs.drug      < DRUG_OK) return 'Drug Deal (acceptable window)';

  return 'CAUTION — all operations at or above baseline risk';
}
