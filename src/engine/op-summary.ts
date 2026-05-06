// ============================================================
// Time-windowed activity rollups for the dashboard's Activity panel.
//
// Mirrors the in-game Activity Log's structure:
//   - Per-op summary: trades, success/fail counts, $DIRTY net,
//     INF net (= -5 × failures since failures forfeit deposit),
//     XP earned (per-op rate × successes only)
//   - Total roll-up across all ops
//   - Multiple windows (e.g. last hour, last 24h, since session start)
//
// The in-game log counts STARTS in the period; we count RESOLUTIONS.
// For most use-cases the difference is negligible (running trades
// resolve within ~1.5h max), but we annotate the panel accordingly.
// ============================================================

import type { Storage, OpOutcome } from '../storage/db';

export type OpType = 'extortion' | 'arms' | 'drug';

// XP earned per successful op (canonical specs from offshoreprotocol.fun/llms.txt)
const XP_PER_SUCCESS: Record<OpType, number> = {
  extortion: 0.8,
  arms: 2.5,
  drug: 7.5,
};

// INF cost per op start (always 5 today)
const INF_COST_PER_OP = 5;

export interface OpSummaryPerType {
  op: OpType;
  trades: number;        // number of resolutions in window
  success: number;
  failure: number;
  dirtyGained: number;   // sum of all $DIRTY paid (success + partial)
  infNet: number;        // negative when burning. = -5 × failures (success refunds the 5)
  xpEarned: number;      // sum across successes
  successRate: number;
  avgDirtyPerOp: number; // gross average, ignoring INF cost
}

export interface OpSummary {
  windowLabel: string;
  windowSec: number;
  fromTs: number;
  toTs: number;
  byOp: Record<OpType, OpSummaryPerType>;
  total: {
    trades: number;
    success: number;
    failure: number;
    dirtyGained: number;
    infNet: number;
    xpEarned: number;
  };
}

function emptyPerType(op: OpType): OpSummaryPerType {
  return {
    op,
    trades: 0, success: 0, failure: 0,
    dirtyGained: 0, infNet: 0, xpEarned: 0,
    successRate: 0, avgDirtyPerOp: 0,
  };
}

/**
 * Aggregate one window of outcomes by op type. Pure function — pass any
 * filtered slice of outcomes you want summarized.
 */
export function summarize(outcomes: OpOutcome[], windowLabel: string, windowSec: number, fromTs: number, toTs: number): OpSummary {
  const byOp: Record<OpType, OpSummaryPerType> = {
    extortion: emptyPerType('extortion'),
    arms: emptyPerType('arms'),
    drug: emptyPerType('drug'),
  };
  for (const r of outcomes) {
    const op = r.opType as OpType;
    if (!byOp[op]) continue;
    const s = byOp[op];
    s.trades++;
    s.dirtyGained += r.dirtyEarned;
    if (r.succeeded === 1) {
      s.success++;
      s.xpEarned += XP_PER_SUCCESS[op];
      // success refunds the deposit → 0 net INF change
    } else {
      s.failure++;
      s.infNet -= INF_COST_PER_OP; // forfeit deposit
    }
  }
  // Finalize derived fields
  for (const op of Object.keys(byOp) as OpType[]) {
    const s = byOp[op];
    s.successRate = s.trades > 0 ? s.success / s.trades : 0;
    s.avgDirtyPerOp = s.trades > 0 ? s.dirtyGained / s.trades : 0;
  }
  const total = {
    trades: byOp.extortion.trades + byOp.arms.trades + byOp.drug.trades,
    success: byOp.extortion.success + byOp.arms.success + byOp.drug.success,
    failure: byOp.extortion.failure + byOp.arms.failure + byOp.drug.failure,
    dirtyGained: byOp.extortion.dirtyGained + byOp.arms.dirtyGained + byOp.drug.dirtyGained,
    infNet: byOp.extortion.infNet + byOp.arms.infNet + byOp.drug.infNet,
    xpEarned: byOp.extortion.xpEarned + byOp.arms.xpEarned + byOp.drug.xpEarned,
  };
  return { windowLabel, windowSec, fromTs, toTs, byOp, total };
}

/**
 * Build the standard set of windows the dashboard renders. The "session"
 * window is set by the caller to the dashboard's process start time, so
 * "while you were away"-style summaries make sense.
 */
export function buildSummaryBundle(
  storage: Storage,
  sessionStartMs: number,
): { last1h: OpSummary; last24h: OpSummary; sinceSession: OpSummary } {
  const now = Date.now();
  const oneHourAgo = now - 3600_000;
  const oneDayAgo = now - 86400_000;
  const sessionTs = Math.min(sessionStartMs, now);

  const last1hRows  = storage.getOpOutcomesSince(oneHourAgo);
  const last24hRows = storage.getOpOutcomesSince(oneDayAgo);
  const sessionRows = storage.getOpOutcomesSince(sessionTs);

  return {
    last1h:       summarize(last1hRows,  'Last hour',  3600,         oneHourAgo, now),
    last24h:      summarize(last24hRows, 'Last 24h',   86400,        oneDayAgo,  now),
    sinceSession: summarize(sessionRows, 'Since restart', Math.floor((now - sessionTs) / 1000), sessionTs, now),
  };
}
