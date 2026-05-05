// ============================================================
// Probability distribution helpers shared between live engine
// and backtester. Keeping these in one place ensures the
// raw P(fail) the calibration tables are fit against is the
// same one the production dashboard emits.
// ============================================================

// Normal CDF approximation (Abramowitz & Stegun 26.2.17)
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327;
  const p = d * Math.exp(-x * x / 2) * t *
    (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Log-gamma via Lanczos approximation
function logGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Regularized incomplete beta I_x(a,b) via Lentz continued fraction
function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - regularizedBeta(1 - x, b, a);

  const lnBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  const maxIter = 200;
  const eps = 1e-14;
  let f = 1, c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < eps) d = eps;
  d = 1 / d;
  f = d;

  for (let m = 1; m <= maxIter; m++) {
    let num = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + num * d;
    if (Math.abs(d) < eps) d = eps;
    c = 1 + num / c;
    if (Math.abs(c) < eps) c = eps;
    d = 1 / d;
    f *= c * d;

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

export function studentTCdf(x: number, df: number): number {
  const xt = df / (df + x * x);
  const beta = regularizedBeta(xt, df / 2, 0.5);
  return x >= 0 ? 1 - 0.5 * beta : 0.5 * beta;
}

// P(min return over windowMin minutes <= -thresholdPct/100), Student-t scaled
// so that variance matches the supplied annualized sigma.
export function dropProbStudentT(
  volAnnualizedPct: number,
  windowMin: number,
  thresholdPct: number,
  df: number,
): number {
  if (volAnnualizedPct <= 0) return 0;
  const volPerMin = (volAnnualizedPct / 100) / Math.sqrt(525600);
  const windowVol = volPerMin * Math.sqrt(windowMin);
  const threshold = thresholdPct / 100;
  const scale = df > 2 ? Math.sqrt((df - 2) / df) : 1;
  const t = (threshold / windowVol) * scale;
  return 1 - studentTCdf(t, df);
}

export function dropProbNormal(
  volAnnualizedPct: number,
  windowMin: number,
  thresholdPct: number,
): number {
  if (volAnnualizedPct <= 0) return 0;
  const volPerMin = (volAnnualizedPct / 100) / Math.sqrt(525600);
  const windowVol = volPerMin * Math.sqrt(windowMin);
  const threshold = thresholdPct / 100;
  const z = threshold / windowVol;
  return 1 - normCdf(z);
}
