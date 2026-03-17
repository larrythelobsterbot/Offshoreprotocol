import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import type { StoredTick, StoredIndicator, DbStats } from '../types';
import { logger } from '../logger';

const DATA_DIR = path.join(process.cwd(), 'data');

export class Storage {
  private db: Database.Database;
  private _insertTick!: Database.Statement;
  private _insertTrade!: Database.Statement;
  private _insertLiq!: Database.Statement;
  private _insertIndicator!: Database.Statement;
  private _insertAlert!: Database.Statement;

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

  getStats(): DbStats {
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM ticks) as tick_count,
        (SELECT COUNT(*) FROM trades) as trade_count,
        (SELECT COUNT(*) FROM liquidations) as liq_count,
        (SELECT COUNT(*) FROM indicators) as indicator_count,
        (SELECT MIN(timestamp) FROM ticks) as earliest_tick,
        (SELECT MAX(timestamp) FROM ticks) as latest_tick
    `).get() as DbStats;
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
    logger.info({ retentionDays: config.dataRetentionDays }, 'Storage cleanup completed');
  }

  close() {
    this.db.close();
  }
}
