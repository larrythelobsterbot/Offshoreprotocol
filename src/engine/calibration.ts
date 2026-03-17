// ============================================================
// Probability Calibration — derived from Phase 4 backtesting
// 90-day backtest (2025-11-17 to 2026-02-16)
//
// The normal CDF model systematically under-predicts failure.
// This module corrects raw predictions using:
// 1. Piecewise linear calibration from backtest calibration tables
// 2. Hourly adjustment factors (14-18 UTC = danger zone)
// 3. Regime-based floor probabilities
// ============================================================

// Calibration points: [rawPredicted, observedActual]
// Derived from 30-day + 90-day backtest calibration tables
const CALIBRATION_POINTS = {
  extortion: [
    [0.000, 0.020],  // floor: even at "0%" predicted, ~2% actual
    [0.006, 0.034],
    [0.034, 0.082],
    [0.076, 0.146],
    [0.151, 0.238],
    [0.270, 0.418],
    [0.384, 0.673],
    [0.500, 0.800],  // extrapolated
    [1.000, 1.000],
  ],
  arms: [
    [0.000, 0.030],  // floor
    [0.004, 0.062],
    [0.034, 0.121],
    [0.074, 0.187],
    [0.146, 0.247],
    [0.264, 0.476],
    [0.382, 0.484],
    [0.500, 0.650],  // extrapolated
    [1.000, 1.000],
  ],
  drug: [
    [0.000, 0.015],  // floor
    [0.003, 0.040],
    [0.034, 0.110],
    [0.074, 0.139],
    [0.145, 0.255],
    [0.248, 0.384],
    [0.390, 0.500],
    [0.500, 0.600],  // extrapolated
    [1.000, 1.000],
  ],
};

// Hourly risk multipliers (UTC) derived from 30d+90d backtest hourly patterns
// Base = 1.0 (average), >1.0 = more dangerous, <1.0 = safer
const HOURLY_MULTIPLIERS: Record<string, number[]> = {
  extortion: [
    0.92, 0.90, 0.94, 0.76, 0.69, 0.66,  // 00-05 UTC
    0.89, 0.76, 0.96, 0.74, 0.60, 0.69,  // 06-11 UTC
    0.82, 0.99, 1.61, 1.60, 1.65, 1.39,  // 12-17 UTC
    1.41, 1.20, 1.20, 0.91, 1.01, 1.01,  // 18-23 UTC
  ],
  arms: [
    0.61, 0.77, 0.98, 0.64, 0.58, 0.79,  // 00-05
    1.15, 0.80, 0.84, 0.45, 0.54, 0.41,  // 06-11
    0.62, 0.98, 2.10, 1.83, 1.75, 1.64,  // 12-17
    1.42, 1.02, 1.02, 1.02, 1.08, 1.08,  // 18-23
  ],
  drug: [
    0.59, 0.87, 0.98, 0.59, 0.49, 0.65,  // 00-05
    0.68, 0.47, 0.53, 0.27, 0.38, 0.49,  // 06-11
    0.53, 1.77, 2.83, 2.12, 1.83, 2.24,  // 12-17
    1.57, 0.81, 0.56, 0.94, 0.94, 0.78,  // 18-23
  ],
};

// Piecewise linear interpolation
export function interpolate(points: number[][], rawProb: number): number {
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
 * Get suggested operation for current conditions
 */
export function getSuggestedOp(
  calibratedProbs: { extortion: number; arms: number; drug: number },
  utcHour: number
): string {
  const hourRisk = getHourlyRiskLevel(utcHour);

  if (hourRisk === 'danger') {
    if (calibratedProbs.drug < 0.10) return 'Drug Deal only (danger hours)';
    return 'AVOID ALL — danger hours + elevated risk';
  }

  if (calibratedProbs.extortion < 0.05) return 'Extortion (excellent window)';
  if (calibratedProbs.extortion < 0.10) return 'Extortion or Arms Deal';
  if (calibratedProbs.arms < 0.15) return 'Arms Deal';
  if (calibratedProbs.drug < 0.15) return 'Drug Deal only';
  return 'CAUTION — all operations elevated risk';
}
