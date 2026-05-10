// ============================================================
// JSON-safe transformer for Infinity / -Infinity / NaN.
//
// Why: `JSON.stringify(Infinity)` returns the string `"null"` (per ECMA),
// which means any number our engines compute as Infinity gets silently
// erased to `null` over the wire. Dashboards that try to distinguish
// "no data" (null) from "perfect score" (Infinity) lose the distinction.
//
// Surface: refund-on-success makes DIRTY/INF mathematically Infinity
// when no failures in the window. We want `∞` rendered, not `—`.
//
// Approach: walk a structurally-cloneable object and replace numeric
// Infinity / -Infinity / NaN with sentinel STRINGS that JSON parses
// cleanly. Dashboards check `typeof v === 'string'` against the
// sentinels before calling `.toFixed()`.
//
// Sentinels:
//   Infinity    → 'Infinity'
//   -Infinity   → '-Infinity'
//   NaN         → 'NaN'
// ============================================================

/**
 * Walk an object/array tree and replace non-finite numbers with sentinel
 * strings so the resulting structure round-trips cleanly through
 * JSON.stringify / JSON.parse.
 *
 * Returns a NEW structure — input is not mutated. Cycles are not
 * supported (none of our API responses have any).
 */
export function jsonSafeInfinity<T>(value: T): T {
  return walk(value) as T;
}

function walk(v: any): any {
  if (typeof v === 'number') {
    if (v === Infinity)  return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    if (Number.isNaN(v)) return 'NaN';
    return v;
  }
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(walk);
  const out: Record<string, any> = {};
  for (const k of Object.keys(v)) out[k] = walk(v[k]);
  return out;
}
