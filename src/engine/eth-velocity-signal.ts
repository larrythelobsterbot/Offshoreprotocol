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
const TRIP_BPS1M_DRUG_PAUSE = -30;
const TRIP_BPS1M_ALL_PAUSE  = -50;
const TRIP_BPS5M_SUSTAINED  = -10;

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
      let risk: EthVelocityRisk = 'safe';
      let wouldPause = false;
      let wouldPauseOpType: 'drug' | 'arms' | 'extortion' | null = null;
      let reason: string | null = null;

      if (v.bps1m <= TRIP_BPS1M_ALL_PAUSE) {
        risk = 'critical';
        wouldPause = true;
        wouldPauseOpType = null;
        reason = `severe 1m drop (${v.bps1m.toFixed(0)}bps/min)`;
      } else if (v.bps5m <= TRIP_BPS5M_SUSTAINED && v.accel < 0) {
        risk = 'critical';
        wouldPause = true;
        wouldPauseOpType = null;
        reason = `sustained ramping drop (5m ${v.bps5m.toFixed(0)}bps/min, accel ${v.accel.toFixed(0)})`;
      } else if (v.bps1m <= TRIP_BPS1M_DRUG_PAUSE) {
        risk = 'critical';
        wouldPause = true;
        wouldPauseOpType = 'drug';
        reason = `drug-window drop (1m ${v.bps1m.toFixed(0)}bps/min)`;
      } else if (v.bps1m <= TRIP_BPS1M_DRUG_PAUSE / 2) {
        risk = 'elevated';
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
