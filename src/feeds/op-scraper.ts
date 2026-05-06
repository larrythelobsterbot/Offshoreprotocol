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
import { logger } from '../logger';

const RPC_URL = 'https://mainnet.megaeth.com/rpc';
const TRADE_COMPLETED_TOPIC = '0x35c06e2c02cc93628588ec67d74925fa30de5c693ea264ec67458bb0b65c3bf1';

// getTradeInfo() selector — matches src/feeds/corp-state.ts
const SEL_GET_TRADE_INFO = '0xd6694027';

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_LOOKBACK_BLOCKS = 100_000; // ~17 minutes at MegaETH 10ms blocks

export type ScrapedOpType = 'extortion' | 'arms' | 'drug' | 'unknown';

export interface ScrapedOpOutcome {
  txHash: string;
  block: number;
  ts: number;          // ms (best effort: now, since fetching block timestamps for every event is heavy)
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
    // Initialize cursor at (latest − initialLookback) so we backfill recent ops on startup.
    try {
      const latestHex = await rpc<string>({ method: 'eth_blockNumber', params: [] });
      const latest = Number(BigInt(latestHex));
      const lookback = this.cfg.initialLookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS;
      this.lastBlockSeen = Math.max(0, latest - lookback);
      logger.info({ from: this.lastBlockSeen, latest }, '[OpScraper] cursor initialized');
    } catch (err: any) {
      logger.error({ err: err.message }, '[OpScraper] failed to init cursor');
    }
    void this.poll();
    this.interval = setInterval(() => void this.poll(), this.cfg.pollMs ?? DEFAULT_POLL_MS);
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

      const fromBlock = '0x' + (this.lastBlockSeen + 1).toString(16);
      const toBlock = '0x' + latest.toString(16);

      // eth_getLogs supports an array of addresses on most clients; if not, we'd
      // need to query each corp separately. MegaETH supports it.
      const logs = await rpc<any[]>({
        method: 'eth_getLogs',
        params: [{
          address: corps,
          topics: [TRADE_COMPLETED_TOPIC],
          fromBlock,
          toBlock,
        }],
      });

      this.alive = true;
      this.emit('status', true);
      this.lastBlockSeen = latest;

      if (logs.length === 0) return;
      logger.info({ count: logs.length }, '[OpScraper] new TradeCompleted events');

      for (const log of logs) {
        try {
          const player = '0x' + log.topics[1].slice(26);
          const corp = '0x' + log.topics[2].slice(26);
          const data = log.data.replace(/^0x/, '');
          const rewardRaw = BigInt('0x' + data.substring(0, 64));
          const influenceRaw = BigInt('0x' + data.substring(64, 128));
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
          const succeeded = rewardDirty >= this.cfg.baseRewardDirty * 0.999; // small float slack

          const outcome: ScrapedOpOutcome = {
            txHash: log.transactionHash,
            block,
            ts: Date.now(),
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
    } catch (err: any) {
      this.alive = false;
      this.emit('status', false);
      logger.error({ err: err.message }, '[OpScraper] poll failed');
    } finally {
      this.inFlight = false;
    }
  }
}
