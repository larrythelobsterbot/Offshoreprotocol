// ============================================================
// Core data types for Offshore Ops Terminal
// ============================================================

import type { EconomicsBlock } from './engine/economics';
import type { OpStatsBlock } from './engine/op-stats';
import type { WalletBalances } from './feeds/onchain-balances';
import type { CorpStateBlock } from './feeds/corp-state';

export interface Tick {
  t: number;   // timestamp ms
  p: number;   // price
}

export interface Trade {
  t: number;
  price: number;
  qty: number;
  usd: number;
  buy: boolean;
  src: 'bin' | 'byb' | 'hl';
}

export interface Liquidation {
  t: number;
  side: 'long' | 'short';
  price: number;
  qty: number;
  usd: number;
  src: 'bin' | 'byb';
}

export interface OrderbookSnapshot {
  bids: [string, string][];  // [price, qty]
  asks: [string, string][];
  imbalance: number;         // -1 to 1
  bidTotal: number;
  askTotal: number;
  spread: number;
  spreadPct: number;
  bidWall: { price: number; size: number } | null;
  askWall: { price: number; size: number } | null;
}

export interface HyperliquidContext {
  funding: number;
  openInterest: number;
  markPrice: number;
  oraclePrice: number;
  premium: number;
  dayVolume: number;
}

export interface PolymarketData {
  probability: number;
  updatedAt: number;
}

export interface CoinglassHeatmapLevel {
  price: number;
  totalValue: number;
  side: 'long' | 'short';  // relative to current price
}

export interface VolatilityData {
  vol5m: number | null;
  vol30m: number | null;
  vol90m: number | null;
  regime: 'low' | 'medium' | 'high' | 'unknown';
  probExtortion: number;
  probArms: number;
  probDrug: number;
}

export interface SafetyScores {
  extortion: number;
  arms: number;
  drug: number;
  probExtortion: number;
  probArms: number;
  probDrug: number;
  cvd1m: number;
  cvd5m: number;
  takerRatio: number;
  binCvd5m: number;
  bybCvd5m: number;
  cvdDivergence: number;
  liqLong5m: number;
  liqShort5m: number;
  liqVelocity: number;
  cascadeRisk: 'LOW' | 'ELEVATED' | 'HIGH' | 'CRITICAL';
  ivrvSpread: number;
  dangerScore: number;
}

export interface DashboardState {
  ethPrice: number | null;
  ethPriceStart: number | null;
  volatility: VolatilityData;
  scores: SafetyScores;
  economics: EconomicsBlock;
  opStats: OpStatsBlock | null;
  walletBalances: WalletBalances | null;
  corpState: CorpStateBlock | null;
  orderbook: {
    binance: OrderbookSnapshot;
    bybit: OrderbookSnapshot;
  };
  cvd: {
    binance: number;
    bybit: number;
    combined: number;
    history: { t: number; v: number }[];
  };
  hyperliquid: HyperliquidContext | null;
  polymarket: PolymarketData | null;
  heatmap: CoinglassHeatmapLevel[];
  liquidations: Liquidation[];
  connections: {
    binance: boolean;
    bybit: boolean;
    hyperliquid: boolean;
    polymarket: boolean;
    coinglass: boolean;
  };
  meta: {
    tickCount: number;
    tradeRate: number;
    uptime: number;
    sources: number;
  };
}

export interface AlertEvent {
  type: 'danger_high' | 'danger_low' | 'cascade' | 'regime_change';
  message: string;
  dangerScore: number;
  timestamp: number;
}

export interface StoredTick {
  timestamp: number;
  price: number;
  source: string;
}

export interface StoredIndicator {
  timestamp: number;
  vol5m: number | null;
  vol30m: number | null;
  vol90m: number | null;
  regime: string;
  danger_score: number;
  score_extortion: number;
  score_arms: number;
  score_drug: number;
  cvd_5m: number;
  ob_imbalance: number;
  liq_velocity: number;
  funding: number | null;
}
