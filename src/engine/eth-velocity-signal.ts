// ============================================================
// EthVelocitySignal — danger-v2 leading indicator.
//
// Polls the VolatilityEngine's getEthVelocity() once per minute and
// computes trip decisions:
//
//   - velocity_1m < -30 bps/min: ETH dropped >0.3% in the last 60s.
//     Trip Drug pause (Drug threshold = 0.518%/90min; if a single
//     minute already covers 60% of that, the next 60s could finish
//     the job).
//
//   - velocity_1m < -50 bps/min: severe single-minute drop. Trip ALL
//     pause regardless of op type — even Arms (0.176%) is at risk.
//
//   - velocity_5m < -10 AND accel < 0: sustained AND ramping. Trip ALL
//     pause as a forward-looking cascade prevention.
//
// Shadow mode: writes "would pause" events to defense_shadow_log
// without emitting any pause signal until ETH_VELOCITY_SHADOW=0.
// ============================================================

import { EventEmitter } from 'events';
import { logger } from '../logger';
import type { Storage } from '../storage/db';
import type { VolatilityEngine } from './volatility';

const POLL_MS = 30_000;          // every 30s; we have minute-resolution data
// Exported so the volatility engine's shadow-danger recompute can
// mirror this classifier exactly — Codex audit #3. Keeping a single
// source of truth for what counts as "elevated" / "critical" ETH
// velocity, since both the live signal AND the shadow recompute need
// to agree on the same thresholds.
export const TRIP_BPS1M_DRUG_PAUSE = -30;
export const TRIP_BPS1M_ALL_PAUSE  = -50;
export const TRIP_BPS5M_SUSTAINED  = -10;

/**
 * Pure classifier mirroring `runOnce()` below. Given the three velocity
 * inputs, returns the same risk tier the live feed would assign. Used
 * by the shadow-danger path; keep behaviour identical to the in-feed
 * classification so HL-vs-RS danger comparisons are like-for-like.
 */
export function classifyEthVelocity(
  bps1m: number | null,
  bps5m: number | null,
  accel: number | null,
): EthVelocityRisk {
  if (bps1m == null) return 'safe';
  if (bps1m <= TRIP_BPS1M_ALL_PAUSE) return 'critical';
  if (bps5m != null && accel != null && bps5m <= TRIP_BPS5M_SUSTAINED && accel < 0) return 'critical';
  if (bps1m <= TRIP_BPS1M_DRUG_PAUSE) return 'critical';
  if (bps1m <= TRIP_BPS1M_DRUG_PAUSE / 2) return 'elevated';
  return 'safe';
}

export type EthVelocityRisk = 'safe' | 'elevated' | 'critical';

export interface EthVelocitySnapshot {
  scannedAt: number;
  bps1m: number | null;
  bps5m: number | null;
  accel: number | null;
  risk: EthVelocityRisk;
  wouldPause: boolean;
  wouldPauseOpType: 'drug' | 'arms' | 'extortion' | null;   // null = all
  reason: string | null;
  shadow: boolean;
}

export interface EthVelocitySignalConfig {
  storage: Storage;
  engine: VolatilityEngine;
  shadow?: boolean;
  pollMs?: number;
}

export class EthVelocitySignal extends EventEmitter {
  private readonly storage: Storage;
  private readonly engine: VolatilityEngine;
  public readonly shadow: boolean;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private latest: EthVelocitySnapshot | null = null;
  private prevWouldPause = false;

  constructor(cfg: EthVelocitySignalConfig) {
    super();
    this.storage = cfg.storage;
    this.engine = cfg.engine;
    this.shadow = cfg.shadow ?? true;
    this.pollMs = cfg.pollMs ?? POLL_MS;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref();
    logger.info({ shadow: this.shadow, pollMs: this.pollMs }, '[EthVelocity] started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSnapshot(): EthVelocitySnapshot | null { return this.latest; }

  private tick(): void {
    const v = this.engine.getEthVelocity();
    const now = Date.now();
    let snap: EthVelocitySnapshot;
    if (!v) {
      snap = {
        scannedAt: now,
        bps1m: null, bps5m: null, accel: null,
        risk: 'safe', wouldPause: false, wouldPauseOpType: null,
        reason: null, shadow: this.shadow,
      };
    } else {
      // Tier from the shared classifier; wouldPause / reason / op-type
      // filter still computed locally because they're feed-specific.
      const risk = classifyEthVelocity(v.bps1m, v.bps5m, v.accel);
      let wouldPause = false;
      let wouldPauseOpType: 'drug' | 'arms' | 'extortion' | null = null;
      let reason: string | null = null;
      if (risk === 'critical') {
        wouldPause = true;
        if (v.bps1m <= TRIP_BPS1M_ALL_PAUSE) {
          reason = `severe 1m drop (${v.bps1m.toFixed(0)}bps/min)`;
        } else if (v.bps5m <= TRIP_BPS5M_SUSTAINED && v.accel < 0) {
          reason = `sustained ramping drop (5m ${v.bps5m.toFixed(0)}bps/min, accel ${v.accel.toFixed(0)})`;
        } else {
          wouldPauseOpType = 'drug';
          reason = `drug-window drop (1m ${v.bps1m.toFixed(0)}bps/min)`;
        }
      }

      snap = {
        scannedAt: now,
        bps1m: v.bps1m, bps5m: v.bps5m, accel: v.accel,
        risk, wouldPause, wouldPauseOpType, reason,
        shadow: this.shadow,
      };
    }

    this.latest = snap;
    if (snap.wouldPause !== this.prevWouldPause) {
      this.emit('transition', { wouldPause: snap.wouldPause, snapshot: snap });
      this.prevWouldPause = snap.wouldPause;
    }
    this.emit('snapshot', snap);

    if (snap.wouldPause) {
      this.storage.insertShadowEvent({
        ts: now,
        signal: 'eth_velocity',
        would_pause: true,
        reason: snap.reason || 'unknown',
        op_type_filter: snap.wouldPauseOpType,
        context_json: {
          bps1m: snap.bps1m, bps5m: snap.bps5m, accel: snap.accel,
          shadow: snap.shadow,
        },
      });
    }
  }
}
