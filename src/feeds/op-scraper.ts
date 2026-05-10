// ============================================================
// On-chain operation outcome scraper.
//
// Watches the player's corp contracts for TradeCompleted events
// and auto-populates the empirical-fraction tracker. Replaces the
// manual Op Outcome Log form: the dashboard now learns the real
// partial-failure fraction from the chain itself.
//
// Event found by inspecting eth_getLogs on an active corp:
//   topic[0] = keccak256("TradeCompleted(address,address,uint256,uint256)")
//            = 0x35c06e2c02cc93628588ec67d74925fa30de5c693ea264ec67458bb0b65c3bf1
//   topic[1] = player address (indexed)
//   topic[2] = company address (indexed)
//   data[0]  = reward in $DIRTY (uint256, 18 decimals)
//   data[1]  = influence cost  (uint256, 18 decimals; always 5e18 today)
//
// To classify the operation type (extortion / arms / drug), we read
// the corp's getTradeInfo() at the block JUST BEFORE the completion
// (when active=true and the trade window is still in state). The
// duration endTime − startTime maps unambiguously:
//    5  min → extortion
//    30 min → arms
//    90 min → drug
//
// Outcome classification:
//    reward == base_reward   → success
//    0 < reward < base       → partial failure
//    reward == 0             → total failure / liquidation
//
// Cursor / dedup:
//   We persist the last-processed block in localStorage equivalent
//   (here: an in-memory map per corp; a future refinement would push
//   this to SQLite to survive restarts cleanly).
// ============================================================

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

const CURSOR_FILE = path.join(process.cwd(), 'data', 'op-scraper-cursor.json');

const RPC_URL = 'https://mainnet.megaeth.com/rpc';
// TradeCompleted(address,address,uint256,uint256)
//   topics: [topic0, player, corp]
//   data:   [reward, influence]
const TRADE_COMPLETED_TOPIC = '0x35c06e2c02cc93628588ec67d74925fa30de5c693ea264ec67458bb0b65c3bf1';

// TradeLiquidated(address,address,address,uint256,uint256,uint256)
//   topics: [topic0, liquidator, player, corp]
//   data:   [ethPriceAtLiq, partialReward, durationOrTicks]
// Verified live: data[1] is the partial $DIRTY paid on liquidation
// (sample observations: 49.57 / 54.31 / 65.06 / 73.69 DIRTY).
const TRADE_LIQUIDATED_TOPIC = '0xbc95a830b1019b9734680ca35152c5632ef54d080bfa3a55531b755867397678';

// getTradeInfo() selector — matches src/feeds/corp-state.ts
const SEL_GET_TRADE_INFO = '0xd6694027';

const DEFAULT_POLL_MS = 30_000;
// MegaETH may produce mini-blocks faster internally, but on-chain
// `block.timestamp` quantizes to 1s and empirically 100k blocks span exactly
// 100k seconds (verified with eth_getBlockByNumber sampling). So 1 block ≈ 1s
// for delta-math purposes; 100k blocks ≈ 27.7h of lookback for first-run.
const DEFAULT_LOOKBACK_BLOCKS = 100_000;
// Wall-clock time per block, used to translate `latest-block` deltas into
// approximate event timestamps so the circuit breaker can tell live
// liquidations apart from backfilled ones. Anchored to chain-reported
// timestamps (1s); a future refinement would query the actual block timestamp
// per event to absorb any sub-second skew.
const MS_PER_BLOCK = 1000;
// eth_getLogs response size limit. Chunk wide ranges so first-run / long-
// downtime resume doesn't trip the RPC's 413 / range-too-large errors.
const MAX_BLOCKS_PER_CHUNK = 5_000;
// Recent txHash dedup ring — survives crashes via cursor file, bounds memory.
const TXHASH_DEDUP_LIMIT = 500;

export type ScrapedOpType = 'extortion' | 'arms' | 'drug' | 'unknown';

export interface ScrapedOpOutcome {
  txHash: string;
  block: number;
  ts: number;          // ms — approximate event timestamp derived from block delta (1 block ≈ 1s on MegaETH)
  player: string;
  corp: string;
  rewardDirty: number; // human-readable
  rewardRaw: string;
  influenceUsed: number;
  baseReward: number;  // base reward used as the success benchmark
  succeeded: boolean;
  opType: ScrapedOpType;
  durationMin: number; // observed window length
  mode: number;        // raw mode value from the trade
}

export interface OpScraperConfig {
  wallet: string;
  // Provider for the current set of corp addresses (changes when the
  // user deploys new ones). Returns lowercase 0x... strings.
  getCorpAddresses: () => string[];
  baseRewardDirty: number;
  pollMs?: number;
  initialLookbackBlocks?: number;
  // Async hook called for every newly-scraped outcome. The dashboard
  // uses this to POST /api/op-result. Errors are logged but don't
  // halt the scraper.
  onOutcome: (o: ScrapedOpOutcome) => Promise<void> | void;
}

interface RpcRequest { method: string; params: any[]; }

async function rpc<T = any>(req: RpcRequest): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...req }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as any;
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

function classifyDuration(durationSec: number): ScrapedOpType {
  // Allow ±20% slack to absorb block-timestamp noise.
  if (durationSec >= 240 && durationSec <= 360) return 'extortion';   // 5 min ±20%
  if (durationSec >= 1440 && durationSec <= 2160) return 'arms';      // 30 min ±20%
  if (durationSec >= 4320 && durationSec <= 6480) return 'drug';      // 90 min ±20%
  return 'unknown';
}

interface DecodedTradeInfo {
  active: boolean;
  mode: number;
  startTime: number;
  endTime: number;
}

function decodeTradeInfo(hex: string): DecodedTradeInfo | null {
  const h = (hex || '').replace(/^0x/, '');
  if (h.length < 64 * 6) return null;
  return {
    active:    parseInt(h.substring(0, 64), 16) === 1,
    mode:      parseInt(h.substring(64, 128), 16),
    startTime: Number(BigInt('0x' + h.substring(256, 320))),
    endTime:   Number(BigInt('0x' + h.substring(320, 384))),
  };
}

export class OpScraperFeed extends EventEmitter {
  private cfg: OpScraperConfig;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastBlockSeen = 0;
  private alive = false;
  private inFlight = false;
  // In-memory dedup of recently-processed txHashes. Persisted in the cursor
  // file so a crash/restart can't re-emit the last batch (the breaker would
  // count those replays toward its window otherwise).
  private recentTxHashes: string[] = [];
  private recentTxHashSet: Set<string> = new Set();

  constructor(cfg: OpScraperConfig) {
    super();
    this.cfg = cfg;
  }

  get connected() { return this.alive; }

  async start() {
    if (!this.cfg.wallet) {
      logger.info('[OpScraper] No wallet configured; scraper disabled.');
      return;
    }
    // Initialize cursor: prefer persisted value (so restarts don't re-emit
    // the same events), fall back to (latest − initialLookback) on first run.
    try {
      const latestHex = await rpc<string>({ method: 'eth_blockNumber', params: [] });
      const latest = Number(BigInt(latestHex));
      const persisted = this.loadCursor();
      if (persisted && persisted > 0 && persisted <= latest) {
        this.lastBlockSeen = persisted;
        logger.info({ resumed: persisted, latest }, '[OpScraper] cursor resumed');
      } else {
        const lookback = this.cfg.initialLookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS;
        this.lastBlockSeen = Math.max(0, latest - lookback);
        logger.info({ from: this.lastBlockSeen, latest }, '[OpScraper] cursor initialized (first run)');
      }
    } catch (err: any) {
      logger.error({ err: err.message }, '[OpScraper] failed to init cursor');
    }
    void this.poll();
    this.interval = setInterval(() => void this.poll(), this.cfg.pollMs ?? DEFAULT_POLL_MS);
  }

  private loadCursor(): number | null {
    try {
      if (!fs.existsSync(CURSOR_FILE)) return null;
      const raw = fs.readFileSync(CURSOR_FILE, 'utf-8');
      const obj = JSON.parse(raw);
      // Restore dedup ring so a crash/restart doesn't replay the last batch.
      if (Array.isArray(obj.recentTxHashes)) {
        this.recentTxHashes = obj.recentTxHashes.slice(-TXHASH_DEDUP_LIMIT);
        this.recentTxHashSet = new Set(this.recentTxHashes);
      }
      return typeof obj.lastBlockSeen === 'number' ? obj.lastBlockSeen : null;
    } catch { return null; }
  }

  /**
   * Atomic cursor write: write to a temp file, fsync, then rename over the
   * destination. A crash mid-write can't corrupt the live cursor file.
   * Includes the txHash dedup ring so restarts don't re-emit the last batch.
   */
  private saveCursor() {
    try {
      const dir = path.dirname(CURSOR_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = CURSOR_FILE + '.tmp';
      const payload = JSON.stringify({
        lastBlockSeen: this.lastBlockSeen,
        recentTxHashes: this.recentTxHashes,
        updated: Date.now(),
      });
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, payload);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, CURSOR_FILE);
    } catch (err: any) {
      logger.warn({ err: err.message }, '[OpScraper] failed to persist cursor');
    }
  }

  /** Record a txHash as processed (capped ring). Returns true if newly seen. */
  private markProcessed(txHash: string): boolean {
    if (!txHash) return true;
    if (this.recentTxHashSet.has(txHash)) return false;
    this.recentTxHashSet.add(txHash);
    this.recentTxHashes.push(txHash);
    if (this.recentTxHashes.length > TXHASH_DEDUP_LIMIT) {
      const evicted = this.recentTxHashes.shift();
      if (evicted) this.recentTxHashSet.delete(evicted);
    }
    return true;
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.alive = false;
  }

  private async poll() {
    if (this.inFlight) return; // skip overlapping polls
    const corps = this.cfg.getCorpAddresses().filter(a => a && a.length === 42);
    if (corps.length === 0) return;
    this.inFlight = true;
    try {
      const latestHex = await rpc<string>({ method: 'eth_blockNumber', params: [] });
      const latest = Number(BigInt(latestHex));
      if (latest <= this.lastBlockSeen) return;
      // Anchor: when this poll happened, the latest block had this timestamp.
      // We approximate event timestamps as `pollNow - (latest - eventBlock) * 1000ms`
      // since MegaETH produces ~1 block/second. Used downstream so the circuit
      // breaker can tell live liquidations apart from backfilled ones.
      const pollNow = Date.now();

      // Chunk wide ranges: first run / long-downtime resume can be 100k+
      // blocks, which trips RPC range limits and 413 response sizes. Process
      // and persist progress per-chunk so a crash mid-replay only loses the
      // current chunk, not everything after the original cursor.
      let chunkStart = this.lastBlockSeen + 1;
      this.alive = true;
      this.emit('status', true);
      while (chunkStart <= latest) {
        const chunkEnd = Math.min(chunkStart + MAX_BLOCKS_PER_CHUNK - 1, latest);
        const fromBlock = '0x' + chunkStart.toString(16);
        const toBlock = '0x' + chunkEnd.toString(16);

        let logs: any[];
        try {
          logs = await rpc<any[]>({
            method: 'eth_getLogs',
            params: [{
              address: corps,
              topics: [[TRADE_COMPLETED_TOPIC, TRADE_LIQUIDATED_TOPIC]],
              fromBlock,
              toBlock,
            }],
          });
        } catch (err: any) {
          // Don't advance past a failed chunk — leave cursor alone so the next
          // poll retries from the same point. Bubble up to outer catch.
          throw err;
        }

        if (logs.length > 0) {
          const liqCount = logs.filter(l => l.topics[0] === TRADE_LIQUIDATED_TOPIC).length;
          const compCount = logs.length - liqCount;
          logger.info(
            { completed: compCount, liquidated: liqCount, fromBlock: chunkStart, toBlock: chunkEnd },
            '[OpScraper] new outcome events',
          );
          await this.processLogs(logs, latest, pollNow, MS_PER_BLOCK);
        }

        // Only advance the cursor AFTER successful processing of this chunk.
        // A crash before this point leaves lastBlockSeen unchanged so the
        // next start re-scans the same chunk (txHash dedup elides duplicates).
        this.lastBlockSeen = chunkEnd;
        this.saveCursor();
        chunkStart = chunkEnd + 1;
      }
    } catch (err: any) {
      this.alive = false;
      this.emit('status', false);
      logger.error({ err: err.message }, '[OpScraper] poll failed');
    } finally {
      this.inFlight = false;
    }
  }

  private async processLogs(logs: any[], latest: number, pollNow: number, msPerBlock: number) {
    for (const log of logs) {
      try {
        // Dedup BEFORE any work — same tx may appear in overlapping ranges
        // after a partial-failure resume. markProcessed returns false if seen.
        if (!this.markProcessed(log.transactionHash)) continue;
        const isLiquidation = log.topics[0] === TRADE_LIQUIDATED_TOPIC;
        // TradeCompleted: topics = [t0, player, corp]
        // TradeLiquidated: topics = [t0, liquidator, player, corp]
        const player = isLiquidation
          ? '0x' + log.topics[2].slice(26)
          : '0x' + log.topics[1].slice(26);
        const corp = isLiquidation
          ? '0x' + log.topics[3].slice(26)
          : '0x' + log.topics[2].slice(26);

        const data = log.data.replace(/^0x/, '');
        let rewardRaw: bigint;
        let influenceRaw: bigint;
        if (isLiquidation) {
          // data layout: [ethPriceAtLiq, partialReward, durationOrTicks]
          rewardRaw = BigInt('0x' + data.substring(64, 128)); // word 2
          // Liquidation forfeits the full live INF stake (~9-12 INF
          // currently, NOT 5). The TL event payload doesn't include
          // the stake, so we'd need a tradeInfo() lookup to get the
          // real number. Index.ts overrides this anyway by reading
          // the live infCostPerOp from OpParamsFeed before persisting
          // to op_outcomes.inf_cost — so this field is unused
          // downstream. Kept as 0 to avoid masking that fact and
          // accidentally re-introducing the hardcoded-5 bug.
          influenceRaw = 0n;
        } else {
          rewardRaw = BigInt('0x' + data.substring(0, 64));
          influenceRaw = BigInt('0x' + data.substring(64, 128));
        }
        const block = Number(BigInt(log.blockNumber));

        // Read the corp's tradeInfo at the block before completion to learn mode + window.
        let mode = 0;
        let durationSec = 0;
        try {
          const priorHex = await rpc<string>({
            method: 'eth_call',
            params: [{ to: corp, data: SEL_GET_TRADE_INFO }, '0x' + (block - 1).toString(16)],
          });
          const ti = decodeTradeInfo(priorHex);
          if (ti) {
            mode = ti.mode;
            durationSec = ti.endTime - ti.startTime;
          }
        } catch (err: any) {
          logger.warn({ err: err.message, block }, '[OpScraper] tradeInfo read failed; classifying as unknown');
        }

        const opType = classifyDuration(durationSec);
        const rewardDirty = Number(rewardRaw) / 1e18;
        // Successful only if the event was TradeCompleted AND the reward
        // matches the base. TradeLiquidated is a failure by definition,
        // even when the partial reward is large.
        const succeeded = !isLiquidation && rewardDirty >= this.cfg.baseRewardDirty * 0.999;

        const outcome: ScrapedOpOutcome = {
          txHash: log.transactionHash,
          block,
          // Approximate event timestamp from block-number delta. Honest
          // about backfills: replayed historical events get accurate
          // historical ts so the circuit breaker can correctly ignore them.
          ts: pollNow - (latest - block) * msPerBlock,
          player,
          corp,
          rewardDirty,
          rewardRaw: rewardRaw.toString(),
          influenceUsed: Number(influenceRaw) / 1e18,
          baseReward: this.cfg.baseRewardDirty,
          succeeded,
          opType,
          durationMin: Math.round(durationSec / 60),
          mode,
        };

        this.emit('outcome', outcome);
        try {
          await this.cfg.onOutcome(outcome);
        } catch (err: any) {
          logger.error({ err: err.message, txHash: log.transactionHash }, '[OpScraper] onOutcome handler threw');
        }
      } catch (err: any) {
        logger.error({ err: err.message, log }, '[OpScraper] failed to process log');
      }
    }
  }
}
