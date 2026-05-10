import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../logger';
import type { StoredTick, StoredIndicator } from '../types';

const DATA_DIR = path.join(process.cwd(), 'data');

export interface Subscriber {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  wallet_address: string | null;
  ref_code: string | null;
  alerts_enabled: number;
  alert_types: string | null;
  last_seen_block: number;
  created_at: number;
  updated_at: number;
}

export interface WhaleClaimRow {
  id?: number;
  ts: number;
  block: number;
  tx_hash: string;
  log_index: number;
  claimer: string;
  cycle_id: number;
  usdm_amount: number;
  whale_rank: number | null;
}

export interface KumbayaLpEventRow {
  id?: number;
  ts: number;
  block: number;
  tx_hash: string;
  log_index: number;
  kind: 'mint' | 'burn' | 'collect';
  owner: string;
  tick_lower: number;
  tick_upper: number;
  liquidity: number | null;
  dirty_amount: number;
  usdm_amount: number;
}

export type WhaleTradeSide =
  | 'buy' | 'sell'           // Kumbaya DEX
  | 'asset_buy'              // Gacha
  | 'op_payout'              // TradeRouter (op reward)
  | 'upgrade' | 'mint'       // burn / mint
  | 'wt_send' | 'wt_recv'    // whale-to-whale
  | 'other';

export interface WhaleTradeRow {
  id?: number;
  ts: number;
  block: number;
  tx_hash: string;
  log_index: number;
  whale_address: string;
  whale_rank: number | null;
  side: WhaleTradeSide;
  dirty_amount: number;
  counterparty: string;
  counterparty_label: string | null;
  usd_value: number | null;
}

export interface SafetyGateRow {
  id?: number;
  ts: number;
  corp: string;
  mode: 0 | 1 | 2;
  op_type: 'extortion' | 'arms' | 'drug';
  safety_score: number | null;
  threshold: number;
  decision: 'allow' | 'block';
  shadow: 0 | 1;
  reason: string | null;
}

export interface ShadowEvent {
  ts: number;
  signal: 'network_health' | 'eth_velocity';
  would_pause: boolean;
  reason: string;
  op_type_filter?: 'drug' | 'arms' | 'extortion' | null;
  context_json?: any;
}

export interface ShadowEventRow {
  id: number;
  ts: number;
  signal: string;
  would_pause: number;        // 0/1
  reason: string;
  op_type_filter: string | null;
  context_json: string | null;
}

export interface NetworkHourlyRow {
  date_hkt: string;             // 'YYYY-MM-DD' in HKT
  hour_hkt: number;             // 0..23
  completed_count: number;      // TC events
  liquidated_count: number;     // TL events (all op types)
  liq_extortion: number;
  liq_arms: number;
  liq_drug: number;
  liq_unknown: number;          // TL with duration outside known windows
  dirty_paid: number;           // sum of TC rewards + TL partial rewards
  scanned_at: number;           // ms when this row was last upserted
}

export interface NetworkOpsHourlyRow {
  date_hkt: string;
  hour_hkt: number;
  op_type: 'extortion' | 'arms' | 'drug' | 'unknown';
  completed_count: number;
  liquidated_count: number;
  dirty_paid: number;
  scanned_at: number;
}

export interface NetworkOpEventModeRow {
  tx_hash: string;
  log_index: number;
  op_type: 'extortion' | 'arms' | 'drug' | 'unknown';
  mode: number | null;
  duration_sec: number | null;
  block_number: number;
  ts: number;
}

export interface DirtyFlowHourlyRow {
  date_hkt: string;
  hour_hkt: number;
  mint_dirty: number;       mint_count: number;
  burn_dirty: number;       burn_count: number;
  sell_pool_dirty: number;  sell_pool_count: number;
  buy_pool_dirty: number;   buy_pool_count: number;
  sell_router_dirty: number; sell_router_count: number;
  buy_router_dirty: number;  buy_router_count: number;
  peer_dirty: number;       peer_count: number;
  scanned_at: number;
}

export interface WhaleCopyRow {
  id?: number;
  ts: number;                       // when whale's copy event was observed
  source_whale: string;             // whale who triggered the copy
  source_mode: 0 | 1 | 2;           // op mode the whale started
  source_corp: string | null;       // whale's corp address that started
  status: 'queued' | 'fired' | 'dropped';
  drop_reason: string | null;       // 'no_corp_available' / 'sr_below_avg' / 'sample_low' / etc.
  our_corp: string | null;          // our corp address that consumed it (NULL if dropped)
  fired_ts: number | null;          // when WE actually startTrade'd
  outcome: 'win' | 'loss' | null;   // resolved later via op-scraper join
  outcome_ts: number | null;
  outcome_dirty: number | null;
}

export interface OpOutcome {
  id?: number;
  ts: number;
  opType: 'extortion' | 'arms' | 'drug';
  succeeded: 0 | 1;
  dirtyEarned: number;
  baseReward: number;
  note?: string | null;
  /** Strategy that bootstrapped this op (e.g. 'auto:all-drug', 'manual:copy'). NULL on legacy rows. */
  strategy?: string | null;
  /** Corp address that ran this op. NULL on legacy rows. */
  corp?: string | null;
  /**
   * INF "stake at risk" — the amount burned at startTrade(). NOT the net cost.
   * Sourced from op_params_history. NULL when unknown.
   */
  infCost?: number | null;
  /**
   * INF actually burned (net cost). Computed as `succeeded ? 0 : infCost`
   * because the contract refunds INF on success via mint-from-0x0
   * (see CLAUDE.md lesson #27). All DIRTY/INF aggregations should use
   * THIS field, not infCost.
   */
  infBurned?: number | null;
}

export interface BootstrapLogRow {
  id?: number;
  ts: number;
  corp: string;
  mode: 0 | 1 | 2;
  strategy: string;
  copy_source_whale: string | null;
  copy_log_id: number | null;
}

export interface StrategyAggregate {
  strategy: string;
  ops: number;
  wins: number;
  losses: number;
  successRate: number;          // wins / ops
  dirtyEarned: number;
  /** Net INF burned (refund-aware). Sum of inf_burned: 0 on successes, full on failures. */
  infBurned: number;
  /** Total INF at risk (gross stake committed across all ops, win or lose). */
  infAtRisk: number;
  /**
   * DIRTY earned per INF actually consumed (dirtyEarned / infBurned).
   * `null` when no INF data is available (inf_samples == 0).
   * `Infinity` when ops resolved but zero failures — operator never lost
   * any INF, so per-INF earnings is unbounded. Renderers must check
   * `Number.isFinite(...)` and display "∞ / no losses" in that case.
   */
  dirtyPerInf: number | null;
}

export class Storage {
  private db: Database.Database;
  private _insertTick!: Database.Statement;
  private _insertTrade!: Database.Statement;
  private _insertLiq!: Database.Statement;
  private _insertIndicator!: Database.Statement;
  private _insertAlert!: Database.Statement;
  private _insertOp!: Database.Statement;
  private _deleteOp!: Database.Statement;

  constructor() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    this.db = new Database(path.join(DATA_DIR, 'offshore.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.init();
    this.prepareStatements();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ticks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        price REAL NOT NULL,
        source TEXT NOT NULL DEFAULT 'bin'
      );
      CREATE INDEX IF NOT EXISTS idx_ticks_ts ON ticks(timestamp);

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        price REAL NOT NULL,
        qty REAL NOT NULL,
        usd REAL NOT NULL,
        buy INTEGER NOT NULL,
        source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(timestamp);

      CREATE TABLE IF NOT EXISTS liquidations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        qty REAL NOT NULL,
        usd REAL NOT NULL,
        source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_liqs_ts ON liquidations(timestamp);

      CREATE TABLE IF NOT EXISTS indicators (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        vol5m REAL,
        vol30m REAL,
        vol90m REAL,
        regime TEXT,
        danger_score REAL,
        score_extortion REAL,
        score_arms REAL,
        score_drug REAL,
        cvd_5m REAL,
        ob_imbalance REAL,
        liq_velocity REAL,
        funding REAL,
        eth_price REAL
      );
      CREATE INDEX IF NOT EXISTS idx_ind_ts ON indicators(timestamp);

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        danger_score REAL
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(timestamp);

      -- Token supply snapshots. One row per (token, timestamp) capture.
      -- Used by the tokenomics feed to compute mint/burn rates and net
      -- inflation across 1h / 24h / 7d windows.
      CREATE TABLE IF NOT EXISTS token_supply_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        total_supply_raw TEXT NOT NULL  -- bigint as string so we don't overflow
      );
      CREATE INDEX IF NOT EXISTS idx_supply_ts ON token_supply_history(ts);
      CREATE INDEX IF NOT EXISTS idx_supply_symbol_ts ON token_supply_history(symbol, ts);

      -- Telegram bot subscribers. Each row is a TG user who has registered
      -- via the bot's /start command and (optionally) bound a wallet for
      -- personal alerts. alert_types is a JSON array of enabled categories;
      -- empty/null means "all enabled". ref_code captures attribution from
      -- ad campaigns or organic referrals (e.g. /start ref=ABC123).
      CREATE TABLE IF NOT EXISTS subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tg_user_id INTEGER UNIQUE NOT NULL,
        tg_username TEXT,
        wallet_address TEXT,
        ref_code TEXT,
        alerts_enabled INTEGER NOT NULL DEFAULT 1,
        alert_types TEXT,
        last_seen_block INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sub_wallet ON subscribers(wallet_address) WHERE wallet_address IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sub_active ON subscribers(alerts_enabled);

      -- Bot alert dedup: one row per (subscriber, alert_key) we've sent.
      -- Used to prevent re-sending the same alert (e.g. "claim ready for corp X")
      -- on every poll while the underlying condition holds.
      CREATE TABLE IF NOT EXISTS bot_alert_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscriber_id INTEGER NOT NULL,
        alert_key TEXT NOT NULL,
        alert_type TEXT NOT NULL,
        ts INTEGER NOT NULL,
        FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_bot_alert_sub_key ON bot_alert_log(subscriber_id, alert_key);
      CREATE INDEX IF NOT EXISTS idx_bot_alert_ts ON bot_alert_log(ts);

      -- Per-op outcome log used to fit empirical partial-failure fractions.
      -- One row per completed operation (success or failure). dirty_earned
      -- is what the player actually received; base_reward is the full-success
      -- reward at their Power Level when the op was logged.
      CREATE TABLE IF NOT EXISTS op_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        op_type TEXT NOT NULL CHECK(op_type IN ('extortion','arms','drug')),
        succeeded INTEGER NOT NULL CHECK(succeeded IN (0,1)),
        dirty_earned REAL NOT NULL,
        base_reward REAL NOT NULL,
        note TEXT,
        -- Strategy attribution: which decision path bootstrapped the op.
        -- One of: 'auto:<preset>', 'manual:<preset>', 'manual:copy',
        -- 'breaker:paused', 'danger:panic', 'fallback:<preset>'. NULL on
        -- legacy rows (pre-attribution) and on outcomes the bot didn't
        -- bootstrap (e.g. ops that were already running when copy-mode
        -- enabled, or the rare contract auto-restart).
        strategy TEXT,
        -- Corp address that ran this op. Lets us join multiple op_outcomes
        -- to a single bootstrap_log row by (corp, ts within window).
        corp TEXT,
        -- INF cost for this op at the time it was bootstrapped (the
        -- "stake at risk" — what was burned at startTrade(), NOT the net
        -- cost). Sourced from op_params_history. Useful for treasury
        -- planning and worst-case INF runway calcs.
        inf_cost REAL,
        -- INF actually burned (net cost) — see CLAUDE.md lesson #27.
        -- The contract burns inf_cost at startTrade(), then mints it back
        -- to the player ~3 blocks after a successful TC. So:
        --   succeeded=1 → inf_burned = 0  (full refund via mint-from-0x0)
        --   succeeded=0 → inf_burned = inf_cost  (forfeit, no refund)
        -- Storing this directly lets all DIRTY/INF aggregations sum a
        -- single column without per-row branching, while preserving the
        -- "at risk" cost in inf_cost for context.
        inf_burned REAL
      );
      CREATE INDEX IF NOT EXISTS idx_op_ts ON op_outcomes(ts);
      CREATE INDEX IF NOT EXISTS idx_op_type ON op_outcomes(op_type);
      -- idx_op_strategy + idx_op_corp_ts are created in the post-init
      -- migration block below, AFTER we ensure the strategy/corp columns
      -- exist on legacy databases via ALTER TABLE ADD COLUMN. Putting them
      -- here would crash on first boot for any DB created before the
      -- attribution feature shipped.

      -- Bootstrap log: one row per startTrade() call by CorpBot. Lets the
      -- op-scraper attach strategy to op_outcomes via (corp, ts within
      -- ~95min tolerance) — that window covers the longest op (Drug 90m)
      -- plus settlement slack.
      CREATE TABLE IF NOT EXISTS bootstrap_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,            -- ms when startTrade() was called
        corp TEXT NOT NULL,             -- corp address that was bootstrapped
        mode INTEGER NOT NULL CHECK(mode IN (0,1,2)),
        strategy TEXT NOT NULL,         -- 'auto:all-drug', 'manual:copy', etc.
        -- Optional whale-copy-specific fields (NULL when strategy != copy)
        copy_source_whale TEXT,
        copy_log_id INTEGER             -- whale_copy_log.id of the matching event
      );
      CREATE INDEX IF NOT EXISTS idx_boot_ts        ON bootstrap_log(ts);
      CREATE INDEX IF NOT EXISTS idx_boot_corp_ts   ON bootstrap_log(corp, ts);
      CREATE INDEX IF NOT EXISTS idx_boot_strategy  ON bootstrap_log(strategy, ts);

      -- Network-wide hourly stats. One row per (HKT date, HKT hour). The
      -- schedule-evidence feed scans TradeCompleted + TradeLiquidated
      -- events daily and stores rollups here. TL events are classified
      -- by op type using the duration field; TC events don't carry op
      -- type cheaply, so liq_* columns are exact while completed_* are
      -- aggregate (the dashboard derives per-op SR using the TL mix).
      -- Shadow-mode log for danger-v2 signals. New defense layers
      -- (NetworkHealth, EthVelocity, etc.) write here before they go live
      -- so we can compute precision/recall against actual op outcomes
      -- BEFORE letting them force-pause the bot.
      --
      -- One row per "would-pause" decision. context_json captures the
      -- signal's input snapshot for offline replay/calibration.
      CREATE TABLE IF NOT EXISTS defense_shadow_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        signal TEXT NOT NULL,         -- 'network_health' | 'eth_velocity'
        would_pause INTEGER NOT NULL, -- 0 = "no trip" (sampled), 1 = "trip"
        reason TEXT NOT NULL,
        op_type_filter TEXT,          -- 'drug' | 'arms' | 'extortion' | NULL (all)
        context_json TEXT             -- raw inputs that drove the decision
      );
      CREATE INDEX IF NOT EXISTS idx_shadow_ts     ON defense_shadow_log(ts);
      CREATE INDEX IF NOT EXISTS idx_shadow_signal ON defense_shadow_log(signal);

      -- Live-sampled op liquidation thresholds. The contract recalibrates
      -- these every ~48h based on network success rate, plus applies a
      -- "weekend leverage" tightening Fri evening → Sun evening. We
      -- sample tradeInfo() across active corps every 10 min and persist
      -- here whenever the value CHANGES, so we have a complete change
      -- history to debug "why did SR drop yesterday".
      CREATE TABLE IF NOT EXISTS op_params_history (
        ts INTEGER NOT NULL,
        mode INTEGER NOT NULL CHECK(mode IN (0,1,2)),
        threshold_pct REAL NOT NULL,    -- e.g. 0.3077 for 0.3077% Drug
        sample_count INTEGER NOT NULL,
        is_weekend INTEGER NOT NULL,    -- 0/1 inferred from HKT day-of-week
        inf_cost_per_op REAL,           -- median INF cost/op observed at this ts (NULL on legacy rows)
        PRIMARY KEY (ts, mode)
      );
      CREATE INDEX IF NOT EXISTS idx_op_params_mode ON op_params_history(mode, ts);
      -- Online migration: the table existed before inf_cost_per_op was added.
      -- ALTER ... ADD COLUMN IF NOT EXISTS isn't supported in SQLite, so we
      -- check the schema first to keep this idempotent across restarts.

      CREATE TABLE IF NOT EXISTS network_hourly_stats (
        date_hkt TEXT NOT NULL,           -- 'YYYY-MM-DD' in HKT
        hour_hkt INTEGER NOT NULL,        -- 0..23
        completed_count INTEGER NOT NULL, -- TradeCompleted events
        liquidated_count INTEGER NOT NULL,-- TradeLiquidated events (all types)
        liq_extortion INTEGER NOT NULL,
        liq_arms INTEGER NOT NULL,
        liq_drug INTEGER NOT NULL,
        liq_unknown INTEGER NOT NULL,
        dirty_paid REAL NOT NULL,
        scanned_at INTEGER NOT NULL,
        PRIMARY KEY (date_hkt, hour_hkt)
      );
      CREATE INDEX IF NOT EXISTS idx_nhs_date ON network_hourly_stats(date_hkt);

      -- Whale Trades: every DIRTY Transfer event involving a top-N
      -- network player. Categorized by counterparty contract:
      --   side = 'buy'        : whale received DIRTY from Kumbaya pool
      --   side = 'sell'       : whale sent DIRTY to Kumbaya pool
      --   side = 'asset_buy'  : whale sent DIRTY to Gacha contract (asset pack)
      --   side = 'op_payout'  : whale received DIRTY from TradeRouter (op reward)
      --   side = 'upgrade'    : whale burned DIRTY (to=0x0) — Status upgrade
      --   side = 'mint'       : whale received DIRTY (from=0x0) — first claim or other mint
      --   side = 'wt_send'    : whale-to-whale transfer (sent)
      --   side = 'wt_recv'    : whale-to-whale transfer (received)
      --   side = 'other'      : transfer to/from unknown EOA or unrecognized contract
      CREATE TABLE IF NOT EXISTS whale_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        block INTEGER NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        whale_address TEXT NOT NULL,        -- the tracked whale's address
        whale_rank INTEGER,                 -- their rank in the top-N at trade time
        side TEXT NOT NULL,
        dirty_amount REAL NOT NULL,
        counterparty TEXT NOT NULL,
        counterparty_label TEXT,            -- human-readable label if known
        usd_value REAL,                     -- best-effort dirty_amount × dirtyPriceUsd
        UNIQUE(tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS idx_wt_ts     ON whale_trades(ts);
      CREATE INDEX IF NOT EXISTS idx_wt_whale  ON whale_trades(whale_address, ts);
      CREATE INDEX IF NOT EXISTS idx_wt_side   ON whale_trades(side, ts);

      -- Safety Gate decisions. Logged BEFORE startTrade fires so we can
      -- compute precision/recall against op_outcomes after a few days.
      -- Each row pairs a "would-block" or "allowed" decision with the
      -- safety score that drove it. Joined to op_outcomes by approximate
      -- timestamp + corp + mode at analysis time.
      CREATE TABLE IF NOT EXISTS safety_gate_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        corp TEXT NOT NULL,
        mode INTEGER NOT NULL CHECK(mode IN (0,1,2)),
        op_type TEXT NOT NULL CHECK(op_type IN ('extortion','arms','drug')),
        safety_score REAL,
        threshold REAL NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
        shadow INTEGER NOT NULL CHECK(shadow IN (0,1)),
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sg_ts   ON safety_gate_log(ts);
      CREATE INDEX IF NOT EXISTS idx_sg_corp ON safety_gate_log(corp, ts);

      -- Vault Claim events — fired when a player claims their cycle
      -- USDM share. Topic[1] = claimer, Topic[2] = cycleId, data = USDM
      -- amount (1e18). Source: CycleRewards contract event 0xf01da32...
      -- Empirically ~350 claims per 8h cycle (every active player + bot).
      CREATE TABLE IF NOT EXISTS whale_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        block INTEGER NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        claimer TEXT NOT NULL,
        cycle_id INTEGER NOT NULL,
        usdm_amount REAL NOT NULL,
        whale_rank INTEGER,                 -- their rank at time of claim, NULL if not in top-N
        UNIQUE(tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS idx_wc_ts        ON whale_claims(ts);
      CREATE INDEX IF NOT EXISTS idx_wc_claimer   ON whale_claims(claimer, ts);
      CREATE INDEX IF NOT EXISTS idx_wc_cycle     ON whale_claims(cycle_id);

      -- Kumbaya LP events — Mint/Burn/Collect on the DIRTY/USDM Univ3 pool.
      -- Mint = LP added, Burn = LP removed (followed by Collect for fees).
      -- "owner" is typically the Univ3 Position Manager NFT, not the
      -- end user. To resolve the true LP we'd need to cross-reference
      -- the matching IncreaseLiquidity/DecreaseLiquidity event on the
      -- Position Manager. For now we record the immediate owner; UI
      -- shows aggregate volumes regardless.
      CREATE TABLE IF NOT EXISTS kumbaya_lp_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        block INTEGER NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('mint','burn','collect')),
        owner TEXT NOT NULL,
        tick_lower INTEGER NOT NULL,
        tick_upper INTEGER NOT NULL,
        liquidity REAL,                     -- raw liquidity uint128 (mint/burn only)
        dirty_amount REAL NOT NULL,
        usdm_amount REAL NOT NULL,
        UNIQUE(tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS idx_klp_ts ON kumbaya_lp_events(ts);
      CREATE INDEX IF NOT EXISTS idx_klp_owner ON kumbaya_lp_events(owner, ts);

      -- Whale copy-trading log. One row per whale-emitted copy event,
      -- regardless of whether we acted on it. Drives the "did the copy
      -- pay off?" SR computation that auto-disables copy-mode if our
      -- recent copy SR drops below the network's rolling SR.
      --
      -- Lifecycle:
      --   queued  : whale started an op; copy event recorded, awaiting a free corp
      --   fired   : we successfully bootstrapped the same mode on one of our corps
      --   dropped : we chose not to copy (no free corp / pool disabled / etc.)
      --
      -- Outcome columns are filled in lazily by joining with op_outcomes
      -- as our copies resolve. fired_ts within ~5 min of an op_outcome.ts
      -- on our_corp ⇒ that outcome is the result of this copy.
      CREATE TABLE IF NOT EXISTS whale_copy_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        source_whale TEXT NOT NULL,
        source_mode INTEGER NOT NULL CHECK(source_mode IN (0,1,2)),
        source_corp TEXT,
        status TEXT NOT NULL CHECK(status IN ('queued','fired','dropped')),
        drop_reason TEXT,
        our_corp TEXT,
        fired_ts INTEGER,
        outcome TEXT CHECK(outcome IN ('win','loss')),
        outcome_ts INTEGER,
        outcome_dirty REAL
      );
      CREATE INDEX IF NOT EXISTS idx_wcl_ts     ON whale_copy_log(ts);
      CREATE INDEX IF NOT EXISTS idx_wcl_whale  ON whale_copy_log(source_whale, ts);
      CREATE INDEX IF NOT EXISTS idx_wcl_status ON whale_copy_log(status, ts);

      -- Network-wide ops by op_type, hourly rollup. One row per
      -- (HKT date, HKT hour, op_type). The NetworkOpsFeed scans every
      -- TC + TL event network-wide, looks up the corp's tradeInfo() at
      -- the block before the event via historical eth_call, and groups
      -- by op_type. This gives us a TRUSTED per-op-type breakdown
      -- network-wide (vs the unreliable TL-duration classification in
      -- network_hourly_stats which only sees time-to-liquidation).
      --
      -- Powers the "your DIRTY/INF vs network" comparison columns on
      -- the INF EFFICIENCY dashboard tile.
      CREATE TABLE IF NOT EXISTS network_ops_hourly (
        date_hkt TEXT NOT NULL,
        hour_hkt INTEGER NOT NULL,
        op_type TEXT NOT NULL CHECK(op_type IN ('extortion','arms','drug','unknown')),
        completed_count INTEGER NOT NULL DEFAULT 0,    -- TC events of this op_type
        liquidated_count INTEGER NOT NULL DEFAULT 0,   -- TL events of this op_type
        dirty_paid REAL NOT NULL DEFAULT 0,            -- sum of TC reward + TL partial
        scanned_at INTEGER NOT NULL,
        PRIMARY KEY (date_hkt, hour_hkt, op_type)
      );
      CREATE INDEX IF NOT EXISTS idx_noh_date ON network_ops_hourly(date_hkt);

      -- Cache for the historical eth_call lookup. One row per (tx_hash,
      -- log_index) with the resolved op_type + raw mode + duration.
      -- Lookups are stable once a block is finalized so we never need
      -- to re-fetch — keeps backfill resumable AND idempotent across
      -- re-scans.
      CREATE TABLE IF NOT EXISTS network_op_event_mode (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        op_type TEXT NOT NULL CHECK(op_type IN ('extortion','arms','drug','unknown')),
        mode INTEGER,                       -- raw mode 0/1/2 or NULL when read failed
        duration_sec INTEGER,               -- full-window duration (TC) or time-to-liq (TL)
        block_number INTEGER NOT NULL,
        ts INTEGER NOT NULL,                -- ms, derived from block delta
        PRIMARY KEY (tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS idx_noem_block ON network_op_event_mode(block_number);

      -- Hourly DIRTY flow rollup. One row per (HKT date, HKT hour). The
      -- DirtyFlowFeed scans DIRTY Transfer events and bucketizes by the
      -- counterparty address — mints/burns hit supply, DEX/router flows
      -- track sell vs buy pressure. Every metric is in DIRTY (1e18 base
      -- already divided), event counts let us spot anomalous activity.
      --
      -- Used by the DIRTY HEALTH dashboard tile + /api/dirty-health to
      -- decide whether to buy or sell DIRTY at the current moment.
      CREATE TABLE IF NOT EXISTS dirty_flow_hourly (
        date_hkt TEXT NOT NULL,                -- 'YYYY-MM-DD' in HKT
        hour_hkt INTEGER NOT NULL,             -- 0..23
        mint_dirty       REAL NOT NULL DEFAULT 0,  -- from=0x0 transfers (TC + dust)
        mint_count       INTEGER NOT NULL DEFAULT 0,
        burn_dirty       REAL NOT NULL DEFAULT 0,  -- to=0x0 (Status + pack burns)
        burn_count       INTEGER NOT NULL DEFAULT 0,
        sell_pool_dirty  REAL NOT NULL DEFAULT 0,  -- to Kumbaya pool (DEX sells)
        sell_pool_count  INTEGER NOT NULL DEFAULT 0,
        buy_pool_dirty   REAL NOT NULL DEFAULT 0,  -- from Kumbaya pool (DEX buys)
        buy_pool_count   INTEGER NOT NULL DEFAULT 0,
        sell_router_dirty REAL NOT NULL DEFAULT 0, -- to TradeRouter (in-game sell)
        sell_router_count INTEGER NOT NULL DEFAULT 0,
        buy_router_dirty  REAL NOT NULL DEFAULT 0, -- from TradeRouter (in-game buy)
        buy_router_count  INTEGER NOT NULL DEFAULT 0,
        peer_dirty       REAL NOT NULL DEFAULT 0,  -- wallet ↔ wallet
        peer_count       INTEGER NOT NULL DEFAULT 0,
        scanned_at       INTEGER NOT NULL,
        PRIMARY KEY (date_hkt, hour_hkt)
      );
      CREATE INDEX IF NOT EXISTS idx_dfh_date ON dirty_flow_hourly(date_hkt);
    `);

    // Online migration: add inf_cost_per_op column to op_params_history if
    // missing. SQLite supports ALTER ADD COLUMN but not IF NOT EXISTS, so
    // we check the schema first. Idempotent across restarts.
    try {
      const cols = this.db.prepare(`PRAGMA table_info(op_params_history)`).all() as { name: string }[];
      if (cols.length > 0 && !cols.some(c => c.name === 'inf_cost_per_op')) {
        this.db.exec(`ALTER TABLE op_params_history ADD COLUMN inf_cost_per_op REAL`);
        logger.info('[Storage] migrated op_params_history: added inf_cost_per_op column');
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, '[Storage] op_params_history migration failed (non-fatal)');
    }

    // Online migration: add strategy / corp / inf_cost columns to op_outcomes
    // for the strategy attribution ledger. Legacy rows stay NULL on these
    // fields; only ops bootstrapped after this deploy get tagged.
    //
    // CREATE INDEX on the new columns runs HERE (not in the schema block
    // above) so the indexes get created AFTER we've ensured the columns
    // exist on legacy DBs.
    try {
      const cols = this.db.prepare(`PRAGMA table_info(op_outcomes)`).all() as { name: string }[];
      const have = new Set(cols.map(c => c.name));
      if (cols.length > 0) {
        if (!have.has('strategy')) {
          this.db.exec(`ALTER TABLE op_outcomes ADD COLUMN strategy TEXT`);
          logger.info('[Storage] migrated op_outcomes: added strategy column');
        }
        if (!have.has('corp')) {
          this.db.exec(`ALTER TABLE op_outcomes ADD COLUMN corp TEXT`);
          logger.info('[Storage] migrated op_outcomes: added corp column');
        }
        if (!have.has('inf_cost')) {
          this.db.exec(`ALTER TABLE op_outcomes ADD COLUMN inf_cost REAL`);
          logger.info('[Storage] migrated op_outcomes: added inf_cost column');
        }
        if (!have.has('inf_burned')) {
          // Add the column AND backfill from existing inf_cost + succeeded.
          // succeeded=1 → 0 (refund via mint-from-0x0); succeeded=0 → inf_cost.
          // The historical pre-attribution rows have inf_cost from the
          // op_params nearest-timestamp backfill (see /tmp/backfill-inf-cost-v2.js)
          // so this migration produces correct values for all existing rows.
          this.db.exec(`ALTER TABLE op_outcomes ADD COLUMN inf_burned REAL`);
          const upd = this.db.prepare(`
            UPDATE op_outcomes
               SET inf_burned = CASE WHEN succeeded = 1 THEN 0 ELSE inf_cost END
             WHERE inf_burned IS NULL
          `);
          const r = upd.run();
          logger.info(
            { changedRows: r.changes },
            '[Storage] migrated op_outcomes: added inf_burned column (refund-on-success modeled)',
          );
        }
      }
      // Indexes are idempotent (IF NOT EXISTS) and safe to re-run on
      // every boot. Run them AFTER the column-add migration completes.
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_op_strategy ON op_outcomes(strategy, ts);
        CREATE INDEX IF NOT EXISTS idx_op_corp_ts  ON op_outcomes(corp, ts);
      `);
    } catch (err: any) {
      logger.warn({ err: err.message }, '[Storage] op_outcomes migration failed (non-fatal)');
    }
  }

  private prepareStatements() {
    this._insertTick = this.db.prepare(
      'INSERT INTO ticks (timestamp, price, source) VALUES (?, ?, ?)'
    );
    this._insertTrade = this.db.prepare(
      'INSERT INTO trades (timestamp, price, qty, usd, buy, source) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this._insertLiq = this.db.prepare(
      'INSERT INTO liquidations (timestamp, side, price, qty, usd, source) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this._insertIndicator = this.db.prepare(
      `INSERT INTO indicators (timestamp, vol5m, vol30m, vol90m, regime, danger_score,
       score_extortion, score_arms, score_drug, cvd_5m, ob_imbalance, liq_velocity, funding, eth_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this._insertAlert = this.db.prepare(
      'INSERT INTO alerts (timestamp, type, message, danger_score) VALUES (?, ?, ?, ?)'
    );
    this._insertOp = this.db.prepare(
      `INSERT INTO op_outcomes (ts, op_type, succeeded, dirty_earned, base_reward, note,
                                strategy, corp, inf_cost, inf_burned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this._deleteOp = this.db.prepare(
      'DELETE FROM op_outcomes WHERE id = ?'
    );
  }

  insertTickBatch(ticks: { t: number; p: number; src: string }[]) {
    const txn = this.db.transaction((items: typeof ticks) => {
      for (const t of items) this._insertTick.run(t.t, t.p, t.src);
    });
    txn(ticks);
  }

  insertTradeBatch(trades: { t: number; price: number; qty: number; usd: number; buy: boolean; src: string }[]) {
    const txn = this.db.transaction((items: typeof trades) => {
      for (const t of items) this._insertTrade.run(t.t, t.price, t.qty, t.usd, t.buy ? 1 : 0, t.src);
    });
    txn(trades);
  }

  insertLiquidation(liq: { t: number; side: string; price: number; qty: number; usd: number; src: string }) {
    this._insertLiq.run(liq.t, liq.side, liq.price, liq.qty, liq.usd, liq.src);
  }

  insertIndicator(ind: StoredIndicator & { eth_price?: number }) {
    this._insertIndicator.run(
      ind.timestamp, ind.vol5m, ind.vol30m, ind.vol90m, ind.regime,
      ind.danger_score, ind.score_extortion, ind.score_arms, ind.score_drug,
      ind.cvd_5m, ind.ob_imbalance, ind.liq_velocity, ind.funding ?? null,
      ind.eth_price ?? null
    );
  }

  insertAlert(alert: { timestamp: number; type: string; message: string; dangerScore: number }) {
    this._insertAlert.run(alert.timestamp, alert.type, alert.message, alert.dangerScore);
  }

  // --- Op outcome log ---

  insertOpOutcome(o: OpOutcome): number {
    // Derive inf_burned at insert time. Caller doesn't have to think about
    // the refund mechanic — they just provide the stake-at-risk (infCost)
    // and we compute the net cost based on succeeded.
    // Explicit override path: if caller provides infBurned, trust it
    // (e.g. backfill scripts or test fixtures).
    const infBurned = o.infBurned !== undefined && o.infBurned !== null
      ? o.infBurned
      : (o.infCost == null ? null : (o.succeeded ? 0 : o.infCost));
    const info = this._insertOp.run(
      o.ts,
      o.opType,
      o.succeeded,
      o.dirtyEarned,
      o.baseReward,
      o.note ?? null,
      o.strategy ?? null,
      o.corp ? o.corp.toLowerCase() : null,
      o.infCost ?? null,
      infBurned,
    );
    return Number(info.lastInsertRowid);
  }

  deleteOpOutcome(id: number): boolean {
    const info = this._deleteOp.run(id);
    return info.changes > 0;
  }

  /**
   * Fetch op outcomes within a time window (newest first). Used by the
   * activity-summary endpoint to roll up "last 24h" / "last hour" /
   * since-session-start views, mirroring the in-game Activity Log.
   */
  getOpOutcomesSince(sinceTs: number): OpOutcome[] {
    return this.db.prepare(
      `SELECT id, ts, op_type as opType, succeeded, dirty_earned as dirtyEarned,
              base_reward as baseReward, note,
              strategy, corp, inf_cost as infCost, inf_burned as infBurned
         FROM op_outcomes WHERE ts >= ? ORDER BY ts DESC`,
    ).all(sinceTs) as OpOutcome[];
  }

  /**
   * Fetch op outcomes ordered newest first, optionally filtered by op type
   * and limited to the last `limit` rows. Used by both stats aggregation
   * and the recent-log UI panel.
   */
  getOpOutcomes(opts: { opType?: 'extortion' | 'arms' | 'drug'; limit?: number } = {}): OpOutcome[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    const cols = `id, ts, op_type as opType, succeeded,
                  dirty_earned as dirtyEarned, base_reward as baseReward, note,
                  strategy, corp, inf_cost as infCost, inf_burned as infBurned`;
    let sql: string;
    let params: any[];
    if (opts.opType) {
      sql = `SELECT ${cols} FROM op_outcomes WHERE op_type = ? ORDER BY ts DESC LIMIT ?`;
      params = [opts.opType, limit];
    } else {
      sql = `SELECT ${cols} FROM op_outcomes ORDER BY ts DESC LIMIT ?`;
      params = [limit];
    }
    return this.db.prepare(sql).all(...params) as OpOutcome[];
  }

  // ────────────────────────────────────────────────────────────
  // Bootstrap log + strategy attribution
  // ────────────────────────────────────────────────────────────

  insertBootstrap(r: Omit<BootstrapLogRow, 'id'>): number {
    const info = this.db.prepare(`
      INSERT INTO bootstrap_log (ts, corp, mode, strategy, copy_source_whale, copy_log_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      r.ts, r.corp.toLowerCase(), r.mode, r.strategy,
      r.copy_source_whale ? r.copy_source_whale.toLowerCase() : null,
      r.copy_log_id,
    );
    return Number(info.lastInsertRowid);
  }

  /**
   * Find the most recent bootstrap on `corp` that lines up with `outcomeTs`
   * (within ~95min — covers the longest op + slack). Returns null if no
   * matching bootstrap, in which case the outcome is logged with NULL
   * strategy (could be a pre-attribution legacy bootstrap, contract
   * auto-restart, or operator UI startTrade).
   */
  findBootstrapForOutcome(corp: string, outcomeTs: number, toleranceMs = 95 * 60_000): BootstrapLogRow | null {
    const minTs = outcomeTs - toleranceMs;
    return (this.db.prepare(`
      SELECT id, ts, corp, mode, strategy, copy_source_whale, copy_log_id
        FROM bootstrap_log
       WHERE corp = ? AND ts BETWEEN ? AND ?
       ORDER BY ts DESC LIMIT 1
    `).get(corp.toLowerCase(), minTs, outcomeTs) as BootstrapLogRow | undefined) ?? null;
  }

  /**
   * Aggregate op_outcomes by strategy over a window. Returns one row per
   * distinct strategy with SR + DIRTY/INF — the headline metrics for the
   * attribution dashboard. Excludes ops with NULL strategy (legacy + the
   * occasional contract auto-restart we couldn't tag).
   */
  getStrategyAttribution(sinceMs: number): StrategyAggregate[] {
    // Sums inf_burned (the NET cost — 0 on success, full on failure)
    // not inf_cost (the at-risk stake). DIRTY/INF here means
    // "DIRTY earned per INF actually consumed", which respects the
    // refund-on-success mechanic (CLAUDE.md lesson #27).
    const rows = this.db.prepare(`
      SELECT
        strategy,
        COUNT(*)                                                AS ops,
        SUM(CASE WHEN succeeded = 1 THEN 1 ELSE 0 END)          AS wins,
        SUM(CASE WHEN succeeded = 0 THEN 1 ELSE 0 END)          AS losses,
        SUM(dirty_earned)                                       AS dirty_earned,
        SUM(COALESCE(inf_burned, 0))                            AS inf_burned,
        SUM(COALESCE(inf_cost, 0))                              AS inf_at_risk,
        SUM(CASE WHEN inf_burned IS NOT NULL THEN 1 ELSE 0 END) AS inf_samples
      FROM op_outcomes
      WHERE strategy IS NOT NULL AND ts >= ?
      GROUP BY strategy
      ORDER BY ops DESC
    `).all(sinceMs) as Array<{
      strategy: string; ops: number; wins: number; losses: number;
      dirty_earned: number; inf_burned: number; inf_at_risk: number; inf_samples: number;
    }>;
    return rows.map(r => {
      // Three cases:
      //   inf_samples == 0           → no INF data at all → null
      //   inf_burned  == 0 && wins>0 → all ops succeeded → Infinity (∞ / no losses)
      //   else                       → standard division
      let dpi: number | null;
      if (r.inf_samples === 0) {
        dpi = null;
      } else if (r.inf_burned === 0) {
        dpi = r.wins > 0 ? Infinity : null;
      } else {
        dpi = r.dirty_earned / r.inf_burned;
      }
      return {
        strategy: r.strategy,
        ops: r.ops,
        wins: r.wins,
        losses: r.losses,
        successRate: r.ops > 0 ? r.wins / r.ops : 0,
        dirtyEarned: r.dirty_earned,
        infBurned: r.inf_burned,
        infAtRisk: r.inf_at_risk,
        dirtyPerInf: dpi,
      };
    });
  }

  // --- Queries ---

  getTicksSince(since: number): StoredTick[] {
    return this.db.prepare('SELECT timestamp, price, source FROM ticks WHERE timestamp > ? ORDER BY timestamp')
      .all(since) as StoredTick[];
  }

  getIndicatorsSince(since: number): StoredIndicator[] {
    return this.db.prepare('SELECT * FROM indicators WHERE timestamp > ? ORDER BY timestamp')
      .all(since) as StoredIndicator[];
  }

  getIndicatorsRange(from: number, to: number): StoredIndicator[] {
    return this.db.prepare('SELECT * FROM indicators WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp')
      .all(from, to) as StoredIndicator[];
  }

  getAlertsSince(since: number) {
    return this.db.prepare('SELECT * FROM alerts WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 50')
      .all(since);
  }

  getLatestIndicator(): StoredIndicator | null {
    return (this.db.prepare('SELECT * FROM indicators ORDER BY timestamp DESC LIMIT 1')
      .get() as StoredIndicator) || null;
  }

  getStats() {
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM ticks) as tick_count,
        (SELECT COUNT(*) FROM trades) as trade_count,
        (SELECT COUNT(*) FROM liquidations) as liq_count,
        (SELECT COUNT(*) FROM indicators) as indicator_count,
        (SELECT MIN(timestamp) FROM ticks) as earliest_tick,
        (SELECT MAX(timestamp) FROM ticks) as latest_tick
    `).get() as any;
    return counts;
  }

  // --- Token supply history ---

  insertTokenSupply(symbol: string, ts: number, totalSupplyRaw: bigint): void {
    this.db.prepare(
      'INSERT INTO token_supply_history (ts, symbol, total_supply_raw) VALUES (?, ?, ?)'
    ).run(ts, symbol, totalSupplyRaw.toString());
  }

  /**
   * Latest supply snapshot for a given token (or null if never recorded).
   */
  getLatestSupply(symbol: string): { ts: number; total_supply_raw: string } | null {
    return (this.db.prepare(
      'SELECT ts, total_supply_raw FROM token_supply_history WHERE symbol = ? ORDER BY ts DESC LIMIT 1'
    ).get(symbol) as any) || null;
  }

  /**
   * The supply snapshot closest to (but not after) `targetTs` for a given
   * token. Used to compute deltas across windows: e.g. snapshotAt(now-24h)
   * vs snapshotAt(now). Returns null if no snapshot is old enough.
   */
  getSupplyAtOrBefore(symbol: string, targetTs: number): { ts: number; total_supply_raw: string } | null {
    return (this.db.prepare(
      'SELECT ts, total_supply_raw FROM token_supply_history WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1'
    ).get(symbol, targetTs) as any) || null;
  }

  // --- Subscribers (Telegram bot service) ---

  upsertSubscriber(s: { tg_user_id: number; tg_username?: string | null; ref_code?: string | null }): Subscriber {
    const now = Date.now();
    const existing = this.db.prepare('SELECT * FROM subscribers WHERE tg_user_id = ?').get(s.tg_user_id) as Subscriber | undefined;
    if (existing) {
      // Update tg_username if it changed; preserve everything else.
      this.db.prepare(`
        UPDATE subscribers SET
          tg_username = COALESCE(?, tg_username),
          ref_code = COALESCE(ref_code, ?),
          updated_at = ?
        WHERE tg_user_id = ?
      `).run(s.tg_username ?? null, s.ref_code ?? null, now, s.tg_user_id);
      return this.db.prepare('SELECT * FROM subscribers WHERE tg_user_id = ?').get(s.tg_user_id) as Subscriber;
    }
    const info = this.db.prepare(`
      INSERT INTO subscribers (tg_user_id, tg_username, ref_code, alerts_enabled, last_seen_block, created_at, updated_at)
      VALUES (?, ?, ?, 1, 0, ?, ?)
    `).run(s.tg_user_id, s.tg_username ?? null, s.ref_code ?? null, now, now);
    return this.db.prepare('SELECT * FROM subscribers WHERE id = ?').get(Number(info.lastInsertRowid)) as Subscriber;
  }

  setSubscriberWallet(tg_user_id: number, wallet: string | null): boolean {
    const info = this.db.prepare(`
      UPDATE subscribers SET wallet_address = ?, last_seen_block = 0, updated_at = ? WHERE tg_user_id = ?
    `).run(wallet, Date.now(), tg_user_id);
    return info.changes > 0;
  }

  setSubscriberAlerts(tg_user_id: number, enabled: boolean): boolean {
    const info = this.db.prepare(
      'UPDATE subscribers SET alerts_enabled = ?, updated_at = ? WHERE tg_user_id = ?'
    ).run(enabled ? 1 : 0, Date.now(), tg_user_id);
    return info.changes > 0;
  }

  getSubscriber(tg_user_id: number): Subscriber | null {
    return (this.db.prepare('SELECT * FROM subscribers WHERE tg_user_id = ?').get(tg_user_id) as Subscriber) || null;
  }

  listActiveSubscribersWithWallet(): Subscriber[] {
    return this.db.prepare(`
      SELECT * FROM subscribers
      WHERE alerts_enabled = 1 AND wallet_address IS NOT NULL
    `).all() as Subscriber[];
  }

  countSubscribers(): { total: number; withWallet: number; active: number } {
    const r = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN wallet_address IS NOT NULL THEN 1 ELSE 0 END) as withWallet,
        SUM(CASE WHEN alerts_enabled = 1 THEN 1 ELSE 0 END) as active
      FROM subscribers
    `).get() as any;
    return { total: r.total || 0, withWallet: r.withWallet || 0, active: r.active || 0 };
  }

  // --- Bot alert dedup ---

  hasRecentAlert(subscriber_id: number, alert_key: string, withinMs: number): boolean {
    const cutoff = Date.now() - withinMs;
    const r = this.db.prepare(
      'SELECT 1 FROM bot_alert_log WHERE subscriber_id = ? AND alert_key = ? AND ts > ? LIMIT 1'
    ).get(subscriber_id, alert_key, cutoff);
    return !!r;
  }

  recordAlert(subscriber_id: number, alert_key: string, alert_type: string): void {
    this.db.prepare(
      'INSERT INTO bot_alert_log (subscriber_id, alert_key, alert_type, ts) VALUES (?, ?, ?, ?)'
    ).run(subscriber_id, alert_key, alert_type, Date.now());
  }

  // --- Cleanup ---

  cleanup() {
    const cutoff = Date.now() - config.dataRetentionDays * 86400_000;
    const tables = ['ticks', 'trades', 'liquidations', 'indicators', 'alerts'];
    const txn = this.db.transaction(() => {
      for (const table of tables) {
        this.db.prepare(`DELETE FROM ${table} WHERE timestamp < ?`).run(cutoff);
      }
    });
    txn();
    this.db.pragma('optimize');
    logger.info({ retentionDays: config.dataRetentionDays }, '[Storage] Cleaned old data');
  }

  // ────────────────────────────────────────────────────────────
  // Network hourly stats (schedule-evidence feed)
  // ────────────────────────────────────────────────────────────

  upsertNetworkHourly(row: NetworkHourlyRow): void {
    this.db.prepare(`
      INSERT INTO network_hourly_stats
        (date_hkt, hour_hkt, completed_count, liquidated_count,
         liq_extortion, liq_arms, liq_drug, liq_unknown,
         dirty_paid, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date_hkt, hour_hkt) DO UPDATE SET
        completed_count  = excluded.completed_count,
        liquidated_count = excluded.liquidated_count,
        liq_extortion    = excluded.liq_extortion,
        liq_arms         = excluded.liq_arms,
        liq_drug         = excluded.liq_drug,
        liq_unknown      = excluded.liq_unknown,
        dirty_paid       = excluded.dirty_paid,
        scanned_at       = excluded.scanned_at
    `).run(
      row.date_hkt, row.hour_hkt, row.completed_count, row.liquidated_count,
      row.liq_extortion, row.liq_arms, row.liq_drug, row.liq_unknown,
      row.dirty_paid, row.scanned_at,
    );
  }

  /** Pull all rows newer than `sinceMs` (scanned_at), ordered. */
  getNetworkHourlySince(sinceMs: number): NetworkHourlyRow[] {
    return this.db.prepare(
      `SELECT * FROM network_hourly_stats WHERE scanned_at >= ? ORDER BY date_hkt, hour_hkt`,
    ).all(sinceMs) as NetworkHourlyRow[];
  }

  // ────────────────────────────────────────────────────────────
  // Network ops hourly + per-event mode cache (NetworkOpsFeed)
  // ────────────────────────────────────────────────────────────

  /**
   * Look up the cached op_type for a TC/TL event. Returns null when
   * never resolved. Used by the feed to skip historical eth_calls on
   * re-scan.
   */
  getNetworkOpEventMode(txHash: string, logIndex: number): NetworkOpEventModeRow | null {
    return (this.db.prepare(
      `SELECT * FROM network_op_event_mode WHERE tx_hash = ? AND log_index = ?`,
    ).get(txHash, logIndex) as NetworkOpEventModeRow | undefined) ?? null;
  }

  /** Persist a resolved event lookup for the cache. */
  insertNetworkOpEventMode(rows: NetworkOpEventModeRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO network_op_event_mode
        (tx_hash, log_index, op_type, mode, duration_sec, block_number, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const txn = this.db.transaction((items: NetworkOpEventModeRow[]) => {
      for (const r of items) stmt.run(
        r.tx_hash, r.log_index, r.op_type, r.mode, r.duration_sec, r.block_number, r.ts,
      );
    });
    txn(rows);
  }

  /**
   * Upsert a network ops hourly bucket. Caller pre-aggregates the
   * (completed, liquidated, dirty_paid) for a (date, hour, op_type)
   * tuple before calling — every upsert REPLACES the existing row's
   * counts, so this is idempotent for re-scans of the same hour.
   */
  upsertNetworkOpsHourly(row: NetworkOpsHourlyRow): void {
    this.db.prepare(`
      INSERT INTO network_ops_hourly
        (date_hkt, hour_hkt, op_type, completed_count, liquidated_count, dirty_paid, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date_hkt, hour_hkt, op_type) DO UPDATE SET
        completed_count  = excluded.completed_count,
        liquidated_count = excluded.liquidated_count,
        dirty_paid       = excluded.dirty_paid,
        scanned_at       = excluded.scanned_at
    `).run(
      row.date_hkt, row.hour_hkt, row.op_type,
      row.completed_count, row.liquidated_count, row.dirty_paid, row.scanned_at,
    );
  }

  /** Pull all network ops rows since `sinceMs` (by scanned_at). */
  getNetworkOpsSince(sinceMs: number): NetworkOpsHourlyRow[] {
    return this.db.prepare(
      `SELECT * FROM network_ops_hourly WHERE scanned_at >= ? ORDER BY date_hkt, hour_hkt`,
    ).all(sinceMs) as NetworkOpsHourlyRow[];
  }

  /** Cache stats — used to surface backfill progress in API responses. */
  getNetworkOpsCacheSize(): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM network_op_event_mode`,
    ).get() as { n: number }).n;
  }

  // ────────────────────────────────────────────────────────────
  // DIRTY flow hourly (DirtyFlowFeed)
  // ────────────────────────────────────────────────────────────

  upsertDirtyFlowHourly(row: DirtyFlowHourlyRow): void {
    this.db.prepare(`
      INSERT INTO dirty_flow_hourly
        (date_hkt, hour_hkt,
         mint_dirty, mint_count,
         burn_dirty, burn_count,
         sell_pool_dirty, sell_pool_count,
         buy_pool_dirty, buy_pool_count,
         sell_router_dirty, sell_router_count,
         buy_router_dirty, buy_router_count,
         peer_dirty, peer_count,
         scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date_hkt, hour_hkt) DO UPDATE SET
        mint_dirty        = excluded.mint_dirty,
        mint_count        = excluded.mint_count,
        burn_dirty        = excluded.burn_dirty,
        burn_count        = excluded.burn_count,
        sell_pool_dirty   = excluded.sell_pool_dirty,
        sell_pool_count   = excluded.sell_pool_count,
        buy_pool_dirty    = excluded.buy_pool_dirty,
        buy_pool_count    = excluded.buy_pool_count,
        sell_router_dirty = excluded.sell_router_dirty,
        sell_router_count = excluded.sell_router_count,
        buy_router_dirty  = excluded.buy_router_dirty,
        buy_router_count  = excluded.buy_router_count,
        peer_dirty        = excluded.peer_dirty,
        peer_count        = excluded.peer_count,
        scanned_at        = excluded.scanned_at
    `).run(
      row.date_hkt, row.hour_hkt,
      row.mint_dirty, row.mint_count,
      row.burn_dirty, row.burn_count,
      row.sell_pool_dirty, row.sell_pool_count,
      row.buy_pool_dirty, row.buy_pool_count,
      row.sell_router_dirty, row.sell_router_count,
      row.buy_router_dirty, row.buy_router_count,
      row.peer_dirty, row.peer_count,
      row.scanned_at,
    );
  }

  /** Pull all DIRTY flow rows since `sinceMs` (chronological). */
  getDirtyFlowSince(sinceMs: number): DirtyFlowHourlyRow[] {
    return this.db.prepare(
      `SELECT * FROM dirty_flow_hourly WHERE scanned_at >= ? ORDER BY date_hkt, hour_hkt`,
    ).all(sinceMs) as DirtyFlowHourlyRow[];
  }

  /** Distinct (date,hour) buckets already scanned — for backfill skipping. */
  getDirtyFlowCollectedHours(): Set<string> {
    const rows = this.db.prepare(
      `SELECT date_hkt, hour_hkt FROM dirty_flow_hourly`,
    ).all() as { date_hkt: string; hour_hkt: number }[];
    return new Set(rows.map(r => `${r.date_hkt}|${r.hour_hkt}`));
  }

  // ────────────────────────────────────────────────────────────
  // Whale Claims (CycleRewards claim events)
  // ────────────────────────────────────────────────────────────

  insertWhaleClaims(rows: WhaleClaimRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO whale_claims
        (ts, block, tx_hash, log_index, claimer, cycle_id, usdm_amount, whale_rank)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const txn = this.db.transaction((items: WhaleClaimRow[]) => {
      for (const r of items) {
        stmt.run(
          r.ts, r.block, r.tx_hash, r.log_index,
          r.claimer.toLowerCase(), r.cycle_id, r.usdm_amount, r.whale_rank,
        );
      }
    });
    txn(rows);
  }

  /** Most recent claims for the dashboard panel. */
  getRecentClaims(limit = 100, opts?: { cycleId?: number; minUsd?: number }): WhaleClaimRow[] {
    const clauses: string[] = [];
    const params: any[] = [];
    if (opts?.cycleId != null) { clauses.push('cycle_id = ?');    params.push(opts.cycleId); }
    if (opts?.minUsd != null)  { clauses.push('usdm_amount >= ?'); params.push(opts.minUsd); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    params.push(limit);
    return this.db.prepare(
      `SELECT * FROM whale_claims ${where} ORDER BY ts DESC LIMIT ?`,
    ).all(...params) as WhaleClaimRow[];
  }

  /** Cursor: highest block already ingested. */
  getWhaleClaimsMaxBlock(): number {
    const row = this.db.prepare(`SELECT MAX(block) as b FROM whale_claims`).get() as { b: number | null };
    return row?.b ?? 0;
  }

  // ────────────────────────────────────────────────────────────
  // Kumbaya LP events
  // ────────────────────────────────────────────────────────────

  insertKumbayaLpEvents(rows: KumbayaLpEventRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO kumbaya_lp_events
        (ts, block, tx_hash, log_index, kind, owner, tick_lower, tick_upper, liquidity, dirty_amount, usdm_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const txn = this.db.transaction((items: KumbayaLpEventRow[]) => {
      for (const r of items) {
        stmt.run(
          r.ts, r.block, r.tx_hash, r.log_index, r.kind,
          r.owner.toLowerCase(), r.tick_lower, r.tick_upper,
          r.liquidity, r.dirty_amount, r.usdm_amount,
        );
      }
    });
    txn(rows);
  }

  getRecentLpEvents(limit = 50): KumbayaLpEventRow[] {
    return this.db.prepare(
      `SELECT * FROM kumbaya_lp_events ORDER BY ts DESC LIMIT ?`,
    ).all(limit) as KumbayaLpEventRow[];
  }

  getKumbayaLpMaxBlock(): number {
    const row = this.db.prepare(`SELECT MAX(block) as b FROM kumbaya_lp_events`).get() as { b: number | null };
    return row?.b ?? 0;
  }

  // ────────────────────────────────────────────────────────────
  // Whale Stance — 24h aggregate per whale (cross-table query)
  // ────────────────────────────────────────────────────────────

  /**
   * Per-whale rollup over the last `windowMs`. Joins whale_trades and
   * whale_claims to give a single row per whale showing their net
   * activity. Returns empty array if no whale activity in window.
   */
  getWhaleStance(windowMs = 86400_000, topN?: number): {
    whale_address: string;
    whale_rank: number | null;
    sells_dirty: number;
    sells_usd: number;
    sells_n: number;
    buys_dirty: number;
    buys_usd: number;
    buys_n: number;
    asset_buys_dirty: number;
    asset_buys_n: number;
    upgrades_dirty: number;
    upgrades_n: number;
    op_payouts_dirty: number;
    op_payouts_n: number;
    claims_usdm: number;
    claims_n: number;
  }[] {
    const since = Date.now() - windowMs;
    // Single-pass aggregate: trades grouped by side, plus claims joined in
    const trades = this.db.prepare(`
      SELECT
        whale_address,
        MAX(whale_rank) as whale_rank,
        SUM(CASE WHEN side = 'sell'      THEN dirty_amount ELSE 0 END) AS sells_dirty,
        SUM(CASE WHEN side = 'sell'      THEN COALESCE(usd_value, 0) ELSE 0 END) AS sells_usd,
        SUM(CASE WHEN side = 'sell'      THEN 1 ELSE 0 END) AS sells_n,
        SUM(CASE WHEN side = 'buy'       THEN dirty_amount ELSE 0 END) AS buys_dirty,
        SUM(CASE WHEN side = 'buy'       THEN COALESCE(usd_value, 0) ELSE 0 END) AS buys_usd,
        SUM(CASE WHEN side = 'buy'       THEN 1 ELSE 0 END) AS buys_n,
        SUM(CASE WHEN side = 'asset_buy' THEN dirty_amount ELSE 0 END) AS asset_buys_dirty,
        SUM(CASE WHEN side = 'asset_buy' THEN 1 ELSE 0 END) AS asset_buys_n,
        SUM(CASE WHEN side = 'upgrade'   THEN dirty_amount ELSE 0 END) AS upgrades_dirty,
        SUM(CASE WHEN side = 'upgrade'   THEN 1 ELSE 0 END) AS upgrades_n,
        SUM(CASE WHEN side = 'op_payout' THEN dirty_amount ELSE 0 END) AS op_payouts_dirty,
        SUM(CASE WHEN side = 'op_payout' THEN 1 ELSE 0 END) AS op_payouts_n
      FROM whale_trades WHERE ts >= ?
      GROUP BY whale_address
    `).all(since) as any[];

    const claims = this.db.prepare(`
      SELECT claimer, SUM(usdm_amount) AS claims_usdm, COUNT(*) AS claims_n
      FROM whale_claims WHERE ts >= ?
      GROUP BY claimer
    `).all(since) as any[];

    const claimMap = new Map<string, { usdm: number; n: number }>();
    for (const c of claims) claimMap.set(c.claimer, { usdm: c.claims_usdm, n: c.claims_n });

    const tradeWhales = new Set(trades.map(t => t.whale_address));

    const merged = trades.map(t => ({
      ...t,
      claims_usdm: claimMap.get(t.whale_address)?.usdm ?? 0,
      claims_n:    claimMap.get(t.whale_address)?.n ?? 0,
    }));
    // Add whales who claimed but didn't trade in window
    for (const c of claims) {
      if (tradeWhales.has(c.claimer)) continue;
      merged.push({
        whale_address: c.claimer,
        whale_rank: null,
        sells_dirty: 0, sells_usd: 0, sells_n: 0,
        buys_dirty: 0, buys_usd: 0, buys_n: 0,
        asset_buys_dirty: 0, asset_buys_n: 0,
        upgrades_dirty: 0, upgrades_n: 0,
        op_payouts_dirty: 0, op_payouts_n: 0,
        claims_usdm: c.claims_usdm, claims_n: c.claims_n,
      });
    }

    // Rank by total $ activity (sells + buys + claims), desc
    merged.sort((a, b) =>
      (b.sells_usd + b.buys_usd + b.claims_usdm) -
      (a.sells_usd + a.buys_usd + a.claims_usdm),
    );
    return topN ? merged.slice(0, topN) : merged;
  }

  // ────────────────────────────────────────────────────────────
  // Whale copy log
  // ────────────────────────────────────────────────────────────

  insertWhaleCopy(r: Omit<WhaleCopyRow, 'id'>): number {
    const info = this.db.prepare(`
      INSERT INTO whale_copy_log
        (ts, source_whale, source_mode, source_corp, status, drop_reason,
         our_corp, fired_ts, outcome, outcome_ts, outcome_dirty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.ts, r.source_whale.toLowerCase(), r.source_mode,
      r.source_corp ? r.source_corp.toLowerCase() : null,
      r.status, r.drop_reason,
      r.our_corp ? r.our_corp.toLowerCase() : null,
      r.fired_ts, r.outcome, r.outcome_ts, r.outcome_dirty,
    );
    return Number(info.lastInsertRowid);
  }

  /**
   * Mark a queued copy as fired by attaching our_corp + fired_ts.
   * Returns the row id updated, or 0 if no matching queued row.
   */
  markCopyFired(id: number, ourCorp: string, firedTs: number): number {
    const info = this.db.prepare(`
      UPDATE whale_copy_log
         SET status   = 'fired',
             our_corp = ?,
             fired_ts = ?
       WHERE id = ? AND status = 'queued'
    `).run(ourCorp.toLowerCase(), firedTs, id);
    return info.changes;
  }

  markCopyDropped(id: number, reason: string): number {
    const info = this.db.prepare(`
      UPDATE whale_copy_log
         SET status      = 'dropped',
             drop_reason = ?
       WHERE id = ? AND status = 'queued'
    `).run(reason, id);
    return info.changes;
  }

  /**
   * Resolve a fired copy's outcome. Called when an op_outcome lands on our_corp
   * within a tolerance of fired_ts. Idempotent — only updates if outcome NULL.
   */
  setCopyOutcome(id: number, outcome: 'win' | 'loss', ts: number, dirty: number): number {
    const info = this.db.prepare(`
      UPDATE whale_copy_log
         SET outcome       = ?,
             outcome_ts    = ?,
             outcome_dirty = ?
       WHERE id = ? AND outcome IS NULL
    `).run(outcome, ts, dirty, id);
    return info.changes;
  }

  /**
   * Best-effort attach: find the most recent fired copy on `corp` whose
   * fired_ts is within `toleranceMs` of `outcomeTs` and still has NULL
   * outcome. Returns row id or 0.
   */
  attachOutcomeToRecentCopy(opts: {
    ourCorp: string;
    outcomeTs: number;
    toleranceMs: number;
    outcome: 'win' | 'loss';
    dirty: number;
  }): number {
    const minTs = opts.outcomeTs - opts.toleranceMs;
    const row = this.db.prepare(`
      SELECT id FROM whale_copy_log
       WHERE our_corp = ?
         AND status = 'fired'
         AND outcome IS NULL
         AND fired_ts BETWEEN ? AND ?
       ORDER BY fired_ts DESC LIMIT 1
    `).get(opts.ourCorp.toLowerCase(), minTs, opts.outcomeTs) as { id: number } | undefined;
    if (!row) return 0;
    return this.setCopyOutcome(row.id, opts.outcome, opts.outcomeTs, opts.dirty);
  }

  /** Recent copies for /bot copy status + dashboard. */
  getRecentCopies(limit = 50): WhaleCopyRow[] {
    return this.db.prepare(
      `SELECT * FROM whale_copy_log ORDER BY ts DESC LIMIT ?`,
    ).all(limit) as WhaleCopyRow[];
  }

  /**
   * Last-N fired copies' SR. Used to auto-disable copy mode if our recent
   * copy success rate drops below the network's rolling SR.
   */
  getRecentCopySR(lastN = 20): { fired: number; resolved: number; wins: number; sr: number | null } {
    const rows = this.db.prepare(`
      SELECT outcome FROM whale_copy_log
       WHERE status = 'fired'
       ORDER BY fired_ts DESC LIMIT ?
    `).all(lastN) as { outcome: 'win' | 'loss' | null }[];
    const fired = rows.length;
    const resolved = rows.filter(r => r.outcome != null).length;
    const wins = rows.filter(r => r.outcome === 'win').length;
    const sr = resolved > 0 ? wins / resolved : null;
    return { fired, resolved, wins, sr };
  }

  // ────────────────────────────────────────────────────────────
  // Safety Gate (precision/recall validation against op outcomes)
  // ────────────────────────────────────────────────────────────

  insertSafetyGateDecision(r: SafetyGateRow): void {
    this.db.prepare(`
      INSERT INTO safety_gate_log
        (ts, corp, mode, op_type, safety_score, threshold, decision, shadow, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.ts, r.corp.toLowerCase(), r.mode, r.op_type,
      r.safety_score, r.threshold, r.decision, r.shadow, r.reason,
    );
  }

  /** Recent decisions for /bot status summary. */
  getRecentSafetyGateDecisions(limit = 20): SafetyGateRow[] {
    return this.db.prepare(
      `SELECT * FROM safety_gate_log ORDER BY id DESC LIMIT ?`,
    ).all(limit) as SafetyGateRow[];
  }

  /** Counts grouped by decision over the last sinceMs. */
  getSafetyGateRollup(sinceMs: number): { decision: string; n: number }[] {
    return this.db.prepare(
      `SELECT decision, COUNT(*) as n FROM safety_gate_log WHERE ts >= ? GROUP BY decision`,
    ).all(sinceMs) as { decision: string; n: number }[];
  }

  // ────────────────────────────────────────────────────────────
  // Whale Trades (DIRTY Transfer events for tracked whales)
  // ────────────────────────────────────────────────────────────

  insertWhaleTrades(rows: WhaleTradeRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO whale_trades
        (ts, block, tx_hash, log_index, whale_address, whale_rank,
         side, dirty_amount, counterparty, counterparty_label, usd_value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const txn = this.db.transaction((items: WhaleTradeRow[]) => {
      for (const r of items) {
        stmt.run(
          r.ts, r.block, r.tx_hash, r.log_index,
          r.whale_address.toLowerCase(), r.whale_rank,
          r.side, r.dirty_amount, r.counterparty.toLowerCase(),
          r.counterparty_label, r.usd_value,
        );
      }
    });
    txn(rows);
  }

  /** Most recent whale trades, optionally filtered by side. */
  getRecentWhaleTrades(limit = 50, opts?: { side?: WhaleTradeSide; minUsd?: number }): WhaleTradeRow[] {
    const clauses: string[] = [];
    const params: any[] = [];
    if (opts?.side)            { clauses.push('side = ?');       params.push(opts.side); }
    if (opts?.minUsd != null)  { clauses.push('usd_value >= ?'); params.push(opts.minUsd); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    params.push(limit);
    return this.db.prepare(
      `SELECT * FROM whale_trades ${where} ORDER BY ts DESC LIMIT ?`,
    ).all(...params) as WhaleTradeRow[];
  }

  /** Cursor: highest block already ingested. Resume after restarts. */
  getWhaleTradesMaxBlock(): number {
    const row = this.db.prepare(`SELECT MAX(block) as b FROM whale_trades`).get() as { b: number | null };
    return row?.b ?? 0;
  }

  // ────────────────────────────────────────────────────────────
  // Op-params history (live-sampled liquidation thresholds)
  // ────────────────────────────────────────────────────────────

  insertOpParams(rows: { ts: number; mode: 0 | 1 | 2; threshold_pct: number; sample_count: number; is_weekend: 0 | 1; inf_cost_per_op?: number | null }[]): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO op_params_history
        (ts, mode, threshold_pct, sample_count, is_weekend, inf_cost_per_op)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const txn = this.db.transaction((items: typeof rows) => {
      for (const r of items) stmt.run(r.ts, r.mode, r.threshold_pct, r.sample_count, r.is_weekend, r.inf_cost_per_op ?? null);
    });
    txn(rows);
  }

  /** Most recent threshold per mode. */
  getLatestOpParams(): Record<0 | 1 | 2, { threshold_pct: number; ts: number; sample_count: number; is_weekend: number; inf_cost_per_op: number | null } | null> {
    const result = { 0: null as any, 1: null as any, 2: null as any };
    for (const m of [0, 1, 2] as const) {
      const row = this.db.prepare(
        `SELECT threshold_pct, ts, sample_count, is_weekend, inf_cost_per_op FROM op_params_history WHERE mode = ? ORDER BY ts DESC LIMIT 1`,
      ).get(m) as any;
      result[m] = row ?? null;
    }
    return result;
  }

  /** All distinct (threshold, is_weekend) values for a mode, ordered oldest→newest. Used for the "change history" panel. */
  getOpParamsHistory(mode: 0 | 1 | 2, limit = 50): { ts: number; threshold_pct: number; sample_count: number; is_weekend: number }[] {
    return this.db.prepare(
      `SELECT ts, threshold_pct, sample_count, is_weekend FROM op_params_history WHERE mode = ? ORDER BY ts DESC LIMIT ?`,
    ).all(mode, limit) as any;
  }

  // ────────────────────────────────────────────────────────────
  // Defense shadow log (danger-v2 calibration)
  // ────────────────────────────────────────────────────────────

  insertShadowEvent(e: ShadowEvent): void {
    this.db.prepare(`
      INSERT INTO defense_shadow_log
        (ts, signal, would_pause, reason, op_type_filter, context_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      e.ts, e.signal, e.would_pause ? 1 : 0, e.reason,
      e.op_type_filter ?? null,
      e.context_json ? JSON.stringify(e.context_json) : null,
    );
  }

  /** Get all shadow events newer than `sinceMs`, ordered oldest→newest. */
  getShadowEventsSince(sinceMs: number, signal?: string): ShadowEventRow[] {
    if (signal) {
      return this.db.prepare(
        `SELECT * FROM defense_shadow_log WHERE ts >= ? AND signal = ? ORDER BY ts`,
      ).all(sinceMs, signal) as ShadowEventRow[];
    }
    return this.db.prepare(
      `SELECT * FROM defense_shadow_log WHERE ts >= ? ORDER BY ts`,
    ).all(sinceMs) as ShadowEventRow[];
  }

  /** Distinct dates already collected — used by the backfill check. */
  getCollectedDates(): string[] {
    return (this.db.prepare(
      `SELECT DISTINCT date_hkt FROM network_hourly_stats ORDER BY date_hkt`,
    ).all() as { date_hkt: string }[]).map(r => r.date_hkt);
  }

  close() {
    this.db.close();
  }
}
