import { describe, it, expect } from 'vitest';
import { normCdf, calcVol, calcDropProb, logGamma, regularizedBeta, studentTCdf, calcDropProbStudentT } from '../volatility';

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

// ============================================================
// Student-t distribution tests (Improvement 8)
// ============================================================

describe('logGamma', () => {
  it('returns 0 for z = 1 (Gamma(1) = 1, log(1) = 0)', () => {
    expect(logGamma(1)).toBeCloseTo(0, 5);
  });

  it('returns log(1) = 0 for z = 2 (Gamma(2) = 1)', () => {
    expect(logGamma(2)).toBeCloseTo(0, 5);
  });

  it('returns log(2) for z = 3 (Gamma(3) = 2)', () => {
    expect(logGamma(3)).toBeCloseTo(Math.log(2), 5);
  });

  it('returns log(6) for z = 4 (Gamma(4) = 6)', () => {
    expect(logGamma(4)).toBeCloseTo(Math.log(6), 5);
  });

  it('returns log(sqrt(pi)) for z = 0.5 (Gamma(0.5) = sqrt(pi))', () => {
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 4);
  });
});

describe('regularizedBeta', () => {
  it('returns 0 for x = 0', () => {
    expect(regularizedBeta(0, 2, 3)).toBe(0);
  });

  it('returns 1 for x = 1', () => {
    expect(regularizedBeta(1, 2, 3)).toBe(1);
  });

  it('returns 0.5 for symmetric case I_0.5(a, a)', () => {
    expect(regularizedBeta(0.5, 3, 3)).toBeCloseTo(0.5, 4);
  });

  it('computes known value I_0.3(2, 5) ≈ 0.5798 (verified via scipy)', () => {
    expect(regularizedBeta(0.3, 2, 5)).toBeCloseTo(0.5798, 3);
  });
});

describe('studentTCdf', () => {
  it('returns 0.5 for t = 0 (any df)', () => {
    expect(studentTCdf(0, 4)).toBeCloseTo(0.5, 6);
    expect(studentTCdf(0, 10)).toBeCloseTo(0.5, 6);
    expect(studentTCdf(0, 100)).toBeCloseTo(0.5, 6);
  });

  it('is symmetric: CDF(t) + CDF(-t) ≈ 1', () => {
    for (const df of [3, 4, 5, 10, 30]) {
      for (const t of [0.5, 1, 2, 3]) {
        expect(studentTCdf(t, df) + studentTCdf(-t, df)).toBeCloseTo(1, 5);
      }
    }
  });

  it('is monotonically increasing', () => {
    const df = 4;
    const values = [-3, -2, -1, 0, 1, 2, 3].map(t => studentTCdf(t, df));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it('has fatter tails than normal (CDF(2, df=4) < normCdf(2))', () => {
    // Student-t with df=4 at t=2 should have a lower CDF than normal at z=2
    // meaning more probability in the tails
    expect(studentTCdf(2, 4)).toBeLessThan(normCdf(2));
  });

  it('converges to normal for large df', () => {
    // For df=1000, should be very close to normal
    expect(studentTCdf(1, 1000)).toBeCloseTo(normCdf(1), 2);
    expect(studentTCdf(2, 1000)).toBeCloseTo(normCdf(2), 2);
  });

  it('matches known values for df=4 (verified via scipy)', () => {
    // t-distribution CDF for df=4: P(T <= 1) ≈ 0.8130
    expect(studentTCdf(1, 4)).toBeCloseTo(0.8130, 3);
    // P(T <= 2) ≈ 0.9419
    expect(studentTCdf(2, 4)).toBeCloseTo(0.9419, 3);
  });

  it('falls back to normCdf for df <= 0', () => {
    expect(studentTCdf(1, 0)).toBeCloseTo(normCdf(1), 5);
    expect(studentTCdf(1, -1)).toBeCloseTo(normCdf(1), 5);
  });
});

describe('calcDropProbStudentT', () => {
  it('returns 0.5 when vol is null', () => {
    expect(calcDropProbStudentT(null, 5, 0.17)).toBe(0.5);
  });

  it('returns a value between 0 and 1', () => {
    const prob = calcDropProbStudentT(50, 5, 0.17, 4);
    expect(prob).toBeGreaterThanOrEqual(0);
    expect(prob).toBeLessThanOrEqual(1);
  });

  it('returns higher probability than normal CDF (fatter tails)', () => {
    const probNormal = calcDropProb(50, 5, 0.17);
    const probStudentT = calcDropProbStudentT(50, 5, 0.17, 4);
    expect(probStudentT).toBeGreaterThan(probNormal);
  });

  it('returns higher probability for higher volatility', () => {
    const probLow = calcDropProbStudentT(20, 5, 0.17, 4);
    const probHigh = calcDropProbStudentT(100, 5, 0.17, 4);
    expect(probHigh).toBeGreaterThan(probLow);
  });

  it('returns lower probability for larger threshold', () => {
    const probSmall = calcDropProbStudentT(50, 5, 0.17, 4);
    const probLarge = calcDropProbStudentT(50, 5, 2.0, 4);
    expect(probSmall).toBeGreaterThan(probLarge);
  });

  it('converges to normal CDF result for large df', () => {
    const probNormal = calcDropProb(50, 5, 0.17);
    const probLargeDf = calcDropProbStudentT(50, 5, 0.17, 1000);
    expect(probLargeDf).toBeCloseTo(probNormal, 2);
  });
});
