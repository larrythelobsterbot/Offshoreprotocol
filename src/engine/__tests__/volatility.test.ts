import { describe, it, expect } from 'vitest';
import { normCdf, calcVol, calcDropProb } from '../volatility';

describe('normCdf', () => {
  it('returns 0.5 for x = 0', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
  });

  it('returns ~0.8413 for x = 1 (one standard deviation)', () => {
    expect(normCdf(1)).toBeCloseTo(0.8413, 3);
  });

  it('returns ~0.1587 for x = -1', () => {
    expect(normCdf(-1)).toBeCloseTo(0.1587, 3);
  });

  it('returns ~0.9772 for x = 2', () => {
    expect(normCdf(2)).toBeCloseTo(0.9772, 3);
  });

  it('returns ~0.0228 for x = -2', () => {
    expect(normCdf(-2)).toBeCloseTo(0.0228, 3);
  });

  it('returns ~0.9987 for x = 3', () => {
    expect(normCdf(3)).toBeCloseTo(0.9987, 3);
  });

  it('approaches 0 for very negative x', () => {
    expect(normCdf(-6)).toBeLessThan(0.001);
    expect(normCdf(-6)).toBeGreaterThanOrEqual(0);
  });

  it('approaches 1 for very positive x', () => {
    expect(normCdf(6)).toBeGreaterThan(0.999);
    expect(normCdf(6)).toBeLessThanOrEqual(1);
  });

  it('is symmetric: normCdf(x) + normCdf(-x) ≈ 1', () => {
    for (const x of [0.5, 1, 1.5, 2, 2.5, 3]) {
      expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 5);
    }
  });

  it('is monotonically increasing', () => {
    const values = [-3, -2, -1, 0, 1, 2, 3].map(normCdf);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });
});

describe('calcVol', () => {
  it('returns null for fewer than 3 returns', () => {
    expect(calcVol([])).toBeNull();
    expect(calcVol([0.01])).toBeNull();
    expect(calcVol([0.01, -0.01])).toBeNull();
  });

  it('returns a positive number for normal returns', () => {
    const returns = [0.001, -0.002, 0.003, -0.001, 0.002];
    const vol = calcVol(returns);
    expect(vol).not.toBeNull();
    expect(vol!).toBeGreaterThan(0);
  });

  it('returns 0 when all returns are identical (zero variance)', () => {
    // With identical returns, variance = 0, so vol = 0
    const returns = [0.001, 0.001, 0.001, 0.001];
    const vol = calcVol(returns);
    expect(vol).not.toBeNull();
    expect(vol!).toBe(0);
  });

  it('produces higher vol for more volatile returns', () => {
    const calm = [0.0001, -0.0001, 0.0001, -0.0001, 0.0001];
    const wild = [0.01, -0.01, 0.01, -0.01, 0.01];
    const volCalm = calcVol(calm)!;
    const volWild = calcVol(wild)!;
    expect(volWild).toBeGreaterThan(volCalm);
  });

  it('annualizes correctly (sqrt(525600) factor)', () => {
    // For known returns, verify the annualization with Bessel's correction
    const returns = [0.01, -0.01, 0.01];
    const vol = calcVol(returns)!;
    const mean = (0.01 + -0.01 + 0.01) / 3;
    const variance = ((0.01 - mean) ** 2 + (-0.01 - mean) ** 2 + (0.01 - mean) ** 2) / 2;
    const stdDev = Math.sqrt(variance);
    const expectedVol = stdDev * Math.sqrt(525600) * 100;
    expect(vol).toBeCloseTo(expectedVol, 4);
  });
});

describe('calcDropProb', () => {
  it('returns 0.5 when vol is null', () => {
    expect(calcDropProb(null, 5, 0.17)).toBe(0.5);
  });

  it('returns a value between 0 and 1', () => {
    const prob = calcDropProb(50, 5, 0.17);
    expect(prob).toBeGreaterThanOrEqual(0);
    expect(prob).toBeLessThanOrEqual(1);
  });

  it('returns higher probability for higher volatility', () => {
    const probLow = calcDropProb(20, 5, 0.17);
    const probHigh = calcDropProb(100, 5, 0.17);
    expect(probHigh).toBeGreaterThan(probLow);
  });

  it('returns lower probability for larger threshold', () => {
    const probSmall = calcDropProb(50, 5, 0.17);
    const probLarge = calcDropProb(50, 5, 2.0);
    expect(probSmall).toBeGreaterThan(probLarge);
  });

  it('returns higher probability for longer windows (more time for drop)', () => {
    const probShort = calcDropProb(50, 5, 0.17);
    const probLong = calcDropProb(50, 30, 0.17);
    expect(probLong).toBeGreaterThan(probShort);
  });

  it('returns near-zero probability with zero vol', () => {
    // With vol = 0, z -> infinity, normCdf(inf) = 1, so prob = 1 - 1 = 0
    // But vol = 0 means volPerMin = 0, z = threshold/0 = Infinity
    const prob = calcDropProb(0, 5, 0.17);
    expect(prob).toBeCloseTo(0, 5);
  });

  it('returns near-zero for very low vol and large threshold', () => {
    const prob = calcDropProb(5, 5, 2.0);
    expect(prob).toBeLessThan(0.01);
  });
});
