import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../logger';
import type { StoredTick, StoredIndicator } from '../types';

const DATA_DIR = path.join(process.cwd(), 'data');

export interface OpOutcome {
  id?: number;
  ts: number;
  opType: 'extortion' | 'arms' | 'drug';
  succeeded: 0 | 1;
  dirtyEarned: number;
  baseReward: number;
  note?: string | null;
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
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_op_ts ON op_outcomes(ts);
      CREATE INDEX IF NOT EXISTS idx_op_type ON op_outcomes(op_type);
    `);
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
      'INSERT INTO op_outcomes (ts, op_type, succeeded, dirty_earned, base_reward, note) VALUES (?, ?, ?, ?, ?, ?)'
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
    const info = this._insertOp.run(
      o.ts,
      o.opType,
      o.succeeded,
      o.dirtyEarned,
      o.baseReward,
      o.note ?? null,
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
      'SELECT id, ts, op_type as opType, succeeded, dirty_earned as dirtyEarned, base_reward as baseReward, note FROM op_outcomes WHERE ts >= ? ORDER BY ts DESC'
    ).all(sinceTs) as OpOutcome[];
  }

  /**
   * Fetch op outcomes ordered newest first, optionally filtered by op type
   * and limited to the last `limit` rows. Used by both stats aggregation
   * and the recent-log UI panel.
   */
  getOpOutcomes(opts: { opType?: 'extortion' | 'arms' | 'drug'; limit?: number } = {}): OpOutcome[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    let sql: string;
    let params: any[];
    if (opts.opType) {
      sql = 'SELECT id, ts, op_type as opType, succeeded, dirty_earned as dirtyEarned, base_reward as baseReward, note FROM op_outcomes WHERE op_type = ? ORDER BY ts DESC LIMIT ?';
      params = [opts.opType, limit];
    } else {
      sql = 'SELECT id, ts, op_type as opType, succeeded, dirty_earned as dirtyEarned, base_reward as baseReward, note FROM op_outcomes ORDER BY ts DESC LIMIT ?';
      params = [limit];
    }
    return this.db.prepare(sql).all(...params) as OpOutcome[];
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

  close() {
    this.db.close();
  }
}
