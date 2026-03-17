import { describe, it, expect } from 'vitest';
import { interpolate, calibrateProb, getHourlyRiskLevel, getSuggestedOp } from '../calibration';

describe('interpolate', () => {
  const points: number[][] = [
    [0.0, 0.02],
    [0.1, 0.10],
    [0.5, 0.80],
    [1.0, 1.00],
  ];

  it('returns the first y for x at or below the first point', () => {
    expect(interpolate(points, 0)).toBe(0.02);
    expect(interpolate(points, -1)).toBe(0.02);
  });

  it('returns the last y for x at or above the last point', () => {
    expect(interpolate(points, 1.0)).toBe(1.0);
    expect(interpolate(points, 2.0)).toBe(1.0);
  });

  it('returns exact y for exact x match', () => {
    expect(interpolate(points, 0.1)).toBeCloseTo(0.10, 6);
    expect(interpolate(points, 0.5)).toBeCloseTo(0.80, 6);
  });

  it('linearly interpolates between points', () => {
    // Between [0.0, 0.02] and [0.1, 0.10], at x=0.05:
    // t = (0.05 - 0) / (0.1 - 0) = 0.5
    // y = 0.02 + 0.5 * (0.10 - 0.02) = 0.06
    expect(interpolate(points, 0.05)).toBeCloseTo(0.06, 6);
  });

  it('interpolates in the middle segment', () => {
    // Between [0.1, 0.10] and [0.5, 0.80], at x=0.3:
    // t = (0.3 - 0.1) / (0.5 - 0.1) = 0.5
    // y = 0.10 + 0.5 * (0.80 - 0.10) = 0.45
    expect(interpolate(points, 0.3)).toBeCloseTo(0.45, 6);
  });

  it('handles single-segment points', () => {
    const simple: number[][] = [[0, 0], [1, 1]];
    expect(interpolate(simple, 0.5)).toBeCloseTo(0.5, 6);
    expect(interpolate(simple, 0.25)).toBeCloseTo(0.25, 6);
  });
});

describe('calibrateProb', () => {
  it('returns floor probability for zero raw probability', () => {
    // The calibration tables have non-zero floors even at rawProb = 0
    const result = calibrateProb(0, 'extortion');
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(0.1);
  });

  it('returns 1.0 for raw probability of 1.0', () => {
    const result = calibrateProb(1.0, 'extortion');
    // Without hourly adjustment, should be 1.0
    expect(result).toBeCloseTo(1.0, 2);
  });

  it('applies hourly adjustment when hour is provided', () => {
    const withoutHour = calibrateProb(0.1, 'extortion');
    const dangerHour = calibrateProb(0.1, 'extortion', 15);  // 15 UTC = danger zone
    const safeHour = calibrateProb(0.1, 'extortion', 4);     // 04 UTC = safe zone

    // Danger hour multiplier > 1, safe hour multiplier < 1
    expect(dangerHour).toBeGreaterThan(withoutHour);
    expect(safeHour).toBeLessThan(withoutHour);
  });

  it('clamps output to [0, 1]', () => {
    // Even with high hourly multiplier, result should not exceed 1
    const result = calibrateProb(0.8, 'extortion', 15);
    expect(result).toBeLessThanOrEqual(1);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('produces monotonically increasing results for increasing raw prob', () => {
    const probs = [0.0, 0.05, 0.1, 0.2, 0.3, 0.5];
    const calibrated = probs.map(p => calibrateProb(p, 'arms'));
    for (let i = 1; i < calibrated.length; i++) {
      expect(calibrated[i]).toBeGreaterThanOrEqual(calibrated[i - 1]);
    }
  });

  it('works for all three operation types', () => {
    for (const opType of ['extortion', 'arms', 'drug'] as const) {
      const result = calibrateProb(0.1, opType);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(1);
    }
  });
});

describe('getHourlyRiskLevel', () => {
  it('returns safe for hours 3-5 and 9-11', () => {
    for (const hour of [3, 4, 5, 9, 10, 11]) {
      expect(getHourlyRiskLevel(hour)).toBe('safe');
    }
  });

  it('returns danger for hours 14-18', () => {
    for (const hour of [14, 15, 16, 17, 18]) {
      expect(getHourlyRiskLevel(hour)).toBe('danger');
    }
  });

  it('returns normal for other hours', () => {
    for (const hour of [0, 1, 2, 6, 7, 8, 12, 13, 19, 20, 21, 22, 23]) {
      expect(getHourlyRiskLevel(hour)).toBe('normal');
    }
  });
});

describe('getSuggestedOp', () => {
  it('warns about danger hours even with low probabilities', () => {
    const result = getSuggestedOp(
      { extortion: 0.03, arms: 0.05, drug: 0.05 },
      15 // danger hour
    );
    expect(result).toContain('danger hours');
  });

  it('suggests extortion for excellent window', () => {
    const result = getSuggestedOp(
      { extortion: 0.03, arms: 0.08, drug: 0.10 },
      3 // safe hour
    );
    expect(result).toContain('Extortion');
    expect(result).toContain('excellent');
  });

  it('suggests caution when all operations are elevated', () => {
    const result = getSuggestedOp(
      { extortion: 0.20, arms: 0.25, drug: 0.25 },
      3
    );
    expect(result).toContain('CAUTION');
  });
});
