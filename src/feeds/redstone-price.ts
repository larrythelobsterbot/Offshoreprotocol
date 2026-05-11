// ============================================================
// RedStonePriceFeed — polls the on-chain RedStone ETH/USD oracle
// at `oracleAddress` (default `0xc555c100db24df36d406243642c169cc5a937f09`
// on MegaETH mainnet). This is the price the Offshore Protocol corp
// contracts actually consult when setting `entryPrice` at trade start
// and when the keeper calls `liquidate()` — so it's the *ground truth*
// for what the game sees, regardless of what Hyperliquid is showing.
//
// Phase 1 scope: feed + divergence-vs-HL computation. The feed runs in
// parallel with Hyperliquid; Hyperliquid is still the primary tick
// source for the danger scorer. The data this feed produces is logged
// to the `oracle_divergence` table and surfaced on the MARKET tab.
//
// Once the divergence sample is large enough to be conclusive, a
// separate migration will move cliff defense + hedge sizing onto this
// feed — but that is out of scope for Phase 1.
// ============================================================

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { logger } from '../logger';

const DEFAULT_RPC = 'https://mainnet.megaeth.com/rpc';

// Chainlink-compatible AggregatorV3 interface — RedStone exposes the
// same shape. We only need latestRoundData + decimals.
const AGGREGATOR_ABI = [
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() external view returns (uint8)',
  'function description() external view returns (string)',
];

export interface RedStonePrice {
  /** Human-readable USD price, e.g. 2332.89. */
  price: number;
  /** Raw int256 from the contract — preserved for audit / re-derivation. */
  rawAnswer: bigint;
  /** Reported by decimals(); typically 8 for ETH/USD. */
  decimals: number;
  /** Chainlink-style round id. */
  roundId: bigint;
  /**
   * Oracle's own "updated at" stamp. We normalise to UNIX SECONDS here
   * — RedStone Classic on some chains reports microseconds, on others
   * seconds. The constructor normaliser handles both at runtime.
   */
  updatedAt: number;
  /** Local wall-clock (ms) at the moment we got the response. */
  fetchedAt: number;
  /** True if updatedAt is older than `staleThresholdS` seconds vs `now`. */
  stale: boolean;
}

export interface RedStoneDivergence {
  redstone: number;
  hyperliquid: number;
  /** Signed: positive = RedStone above HL. */
  diffBps: number;
  /** True when RedStone < HL (= game sees more downside). */
  redstoneLeads: boolean;
  ts: number;
}

export interface RedStonePriceFeedConfig {
  /** Required — the RedStone ETH/USD aggregator address on MegaETH. */
  oracleAddress: string;
  rpcUrl?: string;
  pollMs?: number;
  /** Treat the on-chain price as stale if updatedAt is older than this. */
  staleThresholdS?: number;
  /** Ring buffer capacity for in-memory divergence history. */
  divergenceRingSize?: number;
}

const DEFAULT_POLL_MS = 3_000;
const DEFAULT_STALE_S = 120;
const DEFAULT_RING = 200;
const MAX_BACKOFF_MS = 30_000;
const INIT_BACKOFF_MS = 1_000;

export class RedStonePriceFeed extends EventEmitter {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly contract: ethers.Contract;
  private readonly cfg: Required<Omit<RedStonePriceFeedConfig, 'rpcUrl'>> & { rpcUrl: string };

  /** Resolved on first start(); RedStone ETH/USD on MegaETH = 8. */
  private decimalsValue = 8;
  private readonly divergenceLog: RedStoneDivergence[] = [];
  private current: RedStonePrice | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private backoffMs = 0;
  private consecutiveFailures = 0;
  /**
   * Wall-clock timestamp (ms) of the first failed poll in the current
   * failure run, or null when last poll succeeded. Used to flip
   * `stale: true` precisely after FAILURE_STALE_AFTER_MS of continuous
   * failure regardless of how backoff has progressed. Codex audit #5.
   */
  private failureStartedAtMs: number | null = null;
  private stopped = false;
  private static readonly FAILURE_STALE_AFTER_MS = 5 * 60_000;

  constructor(cfg: RedStonePriceFeedConfig) {
    super();
    if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.oracleAddress)) {
      throw new Error(`[RedStone] invalid oracleAddress: ${cfg.oracleAddress}`);
    }
    this.cfg = {
      oracleAddress: cfg.oracleAddress,
      rpcUrl: cfg.rpcUrl ?? DEFAULT_RPC,
      pollMs: cfg.pollMs ?? DEFAULT_POLL_MS,
      staleThresholdS: cfg.staleThresholdS ?? DEFAULT_STALE_S,
      divergenceRingSize: cfg.divergenceRingSize ?? DEFAULT_RING,
    };
    this.provider = new ethers.JsonRpcProvider(this.cfg.rpcUrl);
    this.contract = new ethers.Contract(this.cfg.oracleAddress, AGGREGATOR_ABI, this.provider);
  }

  /** Latest snapshot or null if first poll hasn't completed (or all failed). */
  getPrice(): RedStonePrice | null { return this.current; }

  /** Read-only view of the in-memory divergence ring. */
  getDivergenceLog(): RedStoneDivergence[] { return this.divergenceLog.slice(); }

  /** Latest divergence sample, or null if the ring is empty. O(1). */
  getLatestDivergence(): RedStoneDivergence | null {
    return this.divergenceLog.length > 0
      ? this.divergenceLog[this.divergenceLog.length - 1]
      : null;
  }

  /** True only when the most recent poll succeeded AND wasn't stale. */
  isHealthy(): boolean {
    return !!this.current && !this.current.stale && this.consecutiveFailures === 0;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Fetch decimals once on init — RedStone publishes ETH/USD with 8
    // decimals on MegaETH (confirmed 2026-05-11), but we read at startup
    // anyway in case the deployment changes.
    try {
      const d = await this.contract.decimals();
      this.decimalsValue = Number(d);
      logger.info({ decimals: this.decimalsValue, oracle: this.cfg.oracleAddress }, '[RedStone] decimals fetched');
    } catch (err: any) {
      logger.warn({ err: err.message }, '[RedStone] decimals() failed; defaulting to 8');
    }
    // Try an initial poll so consumers don't wait pollMs for the first value.
    try { await this.poll(); }
    catch (err: any) { logger.warn({ err: err.message }, '[RedStone] initial poll failed'); }
    this.scheduleNext();
    logger.info(
      { pollMs: this.cfg.pollMs, staleS: this.cfg.staleThresholdS },
      '[RedStone] feed started',
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * Compute and record divergence given an externally-sourced
   * Hyperliquid mark/oracle price (or whichever comparison anchor the
   * caller chooses). Pushes to the in-memory ring and emits a
   * `'divergence'` event so the dashboard wiring + DB logger can react.
   * Safe to call with HL price = 0 or null (no-op).
   */
  recordDivergence(hyperliquidPrice: number | null): RedStoneDivergence | null {
    if (!this.current || !hyperliquidPrice || hyperliquidPrice <= 0) return null;
    const rs = this.current.price;
    const diffBps = ((rs - hyperliquidPrice) / hyperliquidPrice) * 10_000;
    const div: RedStoneDivergence = {
      redstone: rs,
      hyperliquid: hyperliquidPrice,
      diffBps,
      redstoneLeads: rs < hyperliquidPrice,   // game more bearish than HL
      ts: Date.now(),
    };
    this.divergenceLog.push(div);
    if (this.divergenceLog.length > this.cfg.divergenceRingSize) {
      this.divergenceLog.splice(0, this.divergenceLog.length - this.cfg.divergenceRingSize);
    }
    this.emit('divergence', div);
    return div;
  }

  // Memoized stats so the 1Hz WS broadcast doesn't re-walk the ring
  // when nothing has changed. Recomputed only when divergenceLog has
  // grown since the last call (i.e. a new RedStone poll landed).
  private statsCache: {
    samples: number;
    stats: {
      avg5mBps: number; avg1hBps: number; max1hBps: number;
      pctTimeRedstoneLeads: number; samples: number;
    };
  } | null = null;

  /**
   * Rolling-window aggregates from the in-memory ring. Used by the
   * dashboard state attachment so we don't recompute on every WS push.
   * Single-pass walk over the ring; memoized between updates.
   */
  getDivergenceStats(): {
    avg5mBps: number;
    avg1hBps: number;
    max1hBps: number;
    pctTimeRedstoneLeads: number;
    samples: number;
  } {
    if (this.statsCache && this.statsCache.samples === this.divergenceLog.length) {
      return this.statsCache.stats;
    }
    const now = Date.now();
    const cutoff5m = now - 5 * 60_000;
    const cutoff1h = now - 60 * 60_000;
    let sum5m = 0, count5m = 0;
    let sum1h = 0, count1h = 0, max1hAbs = 0, leads1h = 0;
    for (const d of this.divergenceLog) {
      if (d.ts >= cutoff5m) { sum5m += d.diffBps; count5m++; }
      if (d.ts >= cutoff1h) {
        sum1h += d.diffBps;
        count1h++;
        const a = Math.abs(d.diffBps);
        if (a > max1hAbs) max1hAbs = a;
        if (d.redstoneLeads) leads1h++;
      }
    }
    const stats = {
      avg5mBps: count5m > 0 ? sum5m / count5m : 0,
      avg1hBps: count1h > 0 ? sum1h / count1h : 0,
      max1hBps: max1hAbs,
      pctTimeRedstoneLeads: count1h > 0 ? (leads1h / count1h) * 100 : 0,
      samples: this.divergenceLog.length,
    };
    this.statsCache = { samples: this.divergenceLog.length, stats };
    return stats;
  }

  // ──────────────────────────────────────────────────────────────────

  private scheduleNext() {
    if (this.stopped) return;
    const delay = this.backoffMs > 0 ? this.backoffMs : this.cfg.pollMs;
    this.pollTimer = setTimeout(() => { void this.runOnce(); }, delay);
    // Don't keep the process alive solely for this timer.
    if (typeof (this.pollTimer as any).unref === 'function') (this.pollTimer as any).unref();
  }

  private async runOnce(): Promise<void> {
    try {
      await this.poll();
      // Success — reset backoff + failure clock.
      if (this.consecutiveFailures > 0) {
        logger.info({ failures: this.consecutiveFailures }, '[RedStone] feed recovered');
      }
      this.consecutiveFailures = 0;
      this.backoffMs = 0;
      this.failureStartedAtMs = null;
    } catch (err: any) {
      this.consecutiveFailures++;
      if (this.failureStartedAtMs == null) this.failureStartedAtMs = Date.now();
      this.backoffMs = this.backoffMs === 0
        ? INIT_BACKOFF_MS
        : Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      logger.warn(
        { err: err.message, failures: this.consecutiveFailures, nextRetryMs: this.backoffMs },
        '[RedStone] poll failed',
      );
      // Flip the snapshot to stale after a fixed wall-clock window of
      // continuous failure (independent of backoff progression).
      const elapsedFailMs = Date.now() - this.failureStartedAtMs;
      if (this.current && elapsedFailMs > RedStonePriceFeed.FAILURE_STALE_AFTER_MS) {
        this.current = { ...this.current, stale: true };
      }
    }
    this.scheduleNext();
  }

  private async poll(): Promise<void> {
    const res = await this.contract.latestRoundData();
    // ethers v6 returns a typed Result tuple; destructure positionally.
    const [roundId, answer, , updatedAtRaw] = res as unknown as [bigint, bigint, bigint, bigint, bigint];
    if (typeof answer !== 'bigint') {
      throw new Error('[RedStone] latestRoundData returned non-bigint answer');
    }
    if (answer <= 0n) {
      throw new Error(`[RedStone] non-positive answer: ${answer}`);
    }
    // Normalise updatedAt — RedStone variants report timestamps in
    // different units depending on chain config. Magnitude check
    // anchored at "year 2026 in seconds = ~1.78e9":
    //   ≥ 1e17 → nanoseconds  (÷ 1e9)
    //   ≥ 1e14 → microseconds (÷ 1e6)   <- MegaETH RedStone uses this
    //   ≥ 1e11 → milliseconds (÷ 1e3)
    //   else  → already seconds
    let updatedAtSec = Number(updatedAtRaw);
    if      (updatedAtSec >= 1e17) updatedAtSec = Math.floor(updatedAtSec / 1e9);
    else if (updatedAtSec >= 1e14) updatedAtSec = Math.floor(updatedAtSec / 1e6);
    else if (updatedAtSec >= 1e11) updatedAtSec = Math.floor(updatedAtSec / 1e3);

    const nowSec = Math.floor(Date.now() / 1000);
    const stale = (nowSec - updatedAtSec) > this.cfg.staleThresholdS;
    const price = Number(answer) / 10 ** this.decimalsValue;
    // Sanity range — anything outside [50, 50000] for ETH is decode noise
    // or a misconfigured oracle pointer.
    if (!Number.isFinite(price) || price < 50 || price > 50000) {
      throw new Error(`[RedStone] price out of sanity range: ${price}`);
    }
    const snap: RedStonePrice = {
      price,
      rawAnswer: answer,
      decimals: this.decimalsValue,
      roundId,
      updatedAt: updatedAtSec,
      fetchedAt: Date.now(),
      stale,
    };
    this.current = snap;
    this.emit('price', snap);
  }
}
