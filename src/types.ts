// ============================================================
// Core data types for Offshore Ops Terminal
// ============================================================

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

export interface CalibrationInfo {
  hourlyRisk: 'safe' | 'normal' | 'danger';
  utcHour: number;
  suggestion: string;
}

export interface DashboardState {
  ethPrice: number | null;
  ethPriceStart: number | null;
  volatility: VolatilityData;
  scores: SafetyScores;
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
  calibration: CalibrationInfo;
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

// ============================================================
// External API response types
// ============================================================

// --- Binance WebSocket messages ---

export interface BinanceAggTradeMsg {
  e: 'aggTrade';
  E: number;     // Event time
  s: string;     // Symbol
  a: number;     // Aggregate trade ID
  p: string;     // Price
  q: string;     // Quantity
  f: number;     // First trade ID
  l: number;     // Last trade ID
  T: number;     // Trade time
  m: boolean;    // Is buyer the maker?
}

export interface BinanceDepthMsg {
  e: 'depthUpdate';
  E: number;
  s: string;
  lastUpdateId?: number;
  b: [string, string][];   // Bids [price, qty]
  a: [string, string][];   // Asks [price, qty]
  bids?: [string, string][];
  asks?: [string, string][];
}

export interface BinanceForceOrderMsg {
  e: 'forceOrder';
  E: number;
  o: {
    s: string;   // Symbol
    S: 'BUY' | 'SELL';  // Side
    o: string;   // Order type
    f: string;   // Time in force
    q: string;   // Original quantity
    p: string;   // Price
    ap: string;  // Average price
    X: string;   // Order status
    l: string;   // Last filled quantity
    z: string;   // Accumulated filled quantity
    T: number;   // Trade time
  };
}

export interface BinanceKlineMsg {
  e: 'kline';
  E: number;
  s: string;
  k: {
    t: number;   // Kline start time
    T: number;   // Kline close time
    s: string;   // Symbol
    i: string;   // Interval
    o: string;   // Open price
    c: string;   // Close price
    h: string;   // High price
    l: string;   // Low price
    v: string;   // Volume
    x: boolean;  // Is this kline closed?
  };
}

// --- Bybit WebSocket messages ---

export interface BybitTradeMsg {
  topic: 'publicTrade.ETHUSDT';
  type: string;
  ts: number;
  data: {
    T: string;   // Timestamp
    s: string;   // Symbol
    S: 'Buy' | 'Sell';  // Side
    v: string;   // Size
    p: string;   // Price
    L: string;   // Tick direction
    i: string;   // Trade ID
    BT: boolean;
  }[];
}

export interface BybitOrderbookMsg {
  topic: 'orderbook.1.ETHUSDT';
  type: string;
  ts: number;
  data: {
    s: string;
    b: [string, string][];  // Bids [price, qty]
    a: [string, string][];  // Asks [price, qty]
    u: number;
    seq: number;
  };
}

export interface BybitLiquidationMsg {
  topic: 'liquidation.ETHUSDT';
  type: string;
  ts: number;
  data: {
    updatedTime: string;
    symbol: string;
    side: 'Buy' | 'Sell';
    size: string;
    price: string;
  };
}

export interface BybitControlMsg {
  op: string;
  success?: boolean;
  conn_id?: string;
  ret_msg?: string;
}

// --- Hyperliquid REST responses ---

export interface HyperliquidAssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

export interface HyperliquidMeta {
  universe: HyperliquidAssetMeta[];
}

export interface HyperliquidAssetCtx {
  funding: string;
  openInterest: string;
  markPx: string;
  oraclePx: string;
  premium: string;
  dayNtlVlm: string;
}

export type HyperliquidMetaAndCtxResponse = [HyperliquidMeta, HyperliquidAssetCtx[]];

// --- Polymarket REST responses ---

export interface PolymarketPriceResponse {
  price?: string;
  p?: string;
}

// --- Coinglass REST responses ---

export interface CoinglassHeatmapEntry {
  price: string;
  liqValue: string;
  side?: string;
}

export interface CoinglassHeatmapSeparated {
  longs: (CoinglassHeatmapEntry | [string, string])[];
  shorts: (CoinglassHeatmapEntry | [string, string])[];
}

export interface CoinglassApiResponse {
  code: string | number;
  msg?: string;
  data: CoinglassHeatmapEntry[] | CoinglassHeatmapSeparated;
}

// --- DB stats ---

export interface DbStats {
  tick_count: number;
  trade_count: number;
  liq_count: number;
  indicator_count: number;
  earliest_tick: number | null;
  latest_tick: number | null;
}
