// ============================================================
// Reads data/backtest_results_<days>d.json and emits the TS
// literals to paste into src/engine/calibration.ts
// (CALIBRATION_POINTS and HOURLY_MULTIPLIERS).
//
// Usage: npx tsx src/backtest/build-calibration.ts <days>
// ============================================================

import fs from 'fs';
import path from 'path';

interface CalBucket { predRange: [number, number]; count: number; actualRate: number; avgPredicted: number; }
interface HourPt { hour: number; count: number; failRate: number; }
interface Result {
  operation: string;
  totalSimulations: number;
  totalFailures: number;
  overallFailRate: number;
  calibration: CalBucket[];
  hourlyPattern: HourPt[];
}

const days = parseInt(process.argv[2] || '180');
const file = path.join(process.cwd(), 'data', `backtest_results_${days}d.json`);
if (!fs.existsSync(file)) {
  console.error(`Missing ${file}. Run the backtest first.`);
  process.exit(1);
}
const all: Result[] = JSON.parse(fs.readFileSync(file, 'utf-8'));

const fmt = (n: number, digits = 3) => n.toFixed(digits);

// Pool-Adjacent-Violators isotonic regression with bucket-count weights.
// Enforces monotonically non-decreasing actual rates as predicted increases.
function isotonicPAVA(
  pts: { x: number; y: number; w: number }[],
): { x: number; y: number; w: number }[] {
  const out = pts.map(p => ({ ...p }));
  let i = 0;
  while (i < out.length - 1) {
    if (out[i].y > out[i + 1].y) {
      // Pool i and i+1 into a single block weighted by bucket count.
      const wSum = out[i].w + out[i + 1].w;
      const yPool = (out[i].y * out[i].w + out[i + 1].y * out[i + 1].w) / wSum;
      const xPool = (out[i].x * out[i].w + out[i + 1].x * out[i + 1].w) / wSum;
      out[i] = { x: xPool, y: yPool, w: wSum };
      out.splice(i + 1, 1);
      // Step back to recheck the merged block against its predecessor.
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  return out;
}

const MIN_BUCKET_N = 50; // drop buckets with fewer than this many samples

function buildPoints(r: Result): string {
  const filtered = r.calibration.filter(b => b.count >= MIN_BUCKET_N);
  const sorted = [...filtered].sort((a, b) => a.avgPredicted - b.avgPredicted);
  const isoInput = sorted.map(b => ({ x: b.avgPredicted, y: b.actualRate, w: b.count }));
  const iso = isotonicPAVA(isoInput);

  // Floor: extend the lowest isotonic block down to predicted=0.
  const floor = iso[0]?.y ?? 0;
  const lines = [`    [0.000, ${fmt(floor)}],  // floor`];
  for (const p of iso) {
    lines.push(`    [${fmt(p.x)}, ${fmt(p.y)}],  // w=${Math.round(p.w)}`);
  }
  if (iso[iso.length - 1].x < 0.999) {
    lines.push(`    [1.000, 1.000],  // anchor`);
  }
  return lines.join('\n');
}

function buildMultipliers(r: Result): string {
  const overall = r.overallFailRate || 0.0001;
  const mults = r.hourlyPattern.map(h => {
    if (h.count === 0) return 1.0;
    return h.failRate / overall;
  });
  // Format 6 per row matching the existing file style
  const rows: string[] = [];
  for (let i = 0; i < 24; i += 6) {
    const slice = mults.slice(i, i + 6).map(m => m.toFixed(2)).join(', ');
    const range = `${String(i).padStart(2, '0')}-${String(i + 5).padStart(2, '0')} UTC`;
    rows.push(`    ${slice},  // ${range}`);
  }
  return rows.join('\n');
}

console.log('// ============================================================');
console.log(`// Auto-generated from data/backtest_results_${days}d.json`);
console.log('// Paste into src/engine/calibration.ts');
console.log('// ============================================================\n');

console.log('const CALIBRATION_POINTS = {');
for (const r of all) {
  console.log(`  ${r.operation}: [`);
  console.log(buildPoints(r));
  console.log('  ],');
}
console.log('};\n');

console.log('const HOURLY_MULTIPLIERS: Record<string, number[]> = {');
for (const r of all) {
  console.log(`  ${r.operation}: [`);
  console.log(buildMultipliers(r));
  console.log('  ],');
}
console.log('};');

// Summary on stderr
for (const r of all) {
  console.error(`# ${r.operation}: n=${r.totalSimulations}  failRate=${(r.overallFailRate*100).toFixed(2)}%  buckets=${r.calibration.length}`);
}
