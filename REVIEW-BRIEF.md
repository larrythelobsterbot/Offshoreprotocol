# Offshore Ops Terminal v3.1 — Code Review Brief

## What This Is

A real-time ETH volatility monitoring dashboard built for **Offshore Protocol**, an on-chain game on MegaETH where players run simulated "operations" (Extortion, Arms Deal, Drug Deal) that are essentially paper leveraged trades on ETH. If ETH drops more than a threshold % within the operation window, the operation fails and you lose your deposit. The dashboard monitors market conditions and predicts the probability of failure for each operation type in real-time.

**The system is live on a Hetzner VPS (Ubuntu, Finland) running 24/7 via PM2.**

## Architecture

```
Exchange WebSockets ──┐
(Binance, Bybit)      │
                      ▼
REST Polls ──────► VolatilityEngine ──► Fastify API ──► Browser Dashboard
(Hyperliquid,        (computes vol,       (REST +        (single-page HTML,
 Polymarket,          scores, danger)      WebSocket)      connects via WS)
 Coinglass)               │
                          ├──► SQLite (persistent storage, 30-day retention)
                          └──► Telegram Alerts (on danger regime changes)
```

All processing happens server-side. The browser is a dumb render client that receives state every 1 second over WebSocket.

## Game Parameters (as modeled)

| Operation  | Leverage | Window  | Max Drop Threshold | Description |
|------------|----------|---------|-------------------|-------------|
| Extortion  | 600x     | 5 min   | 0.17%             | Highest risk, shortest window |
| Arms Deal  | 140x     | 30 min  | 0.71%             | Medium risk/duration |
| Drug Deal  | 50x      | 90 min  | 2.0%              | Lowest risk, longest window |

**Note:** These parameters were derived from leverage ratios. The actual game (launching ~Feb 19, 2026) may use different values — e.g., screenshots show Arms Deal at 2 hours duration. The engine should be reconfigured once final game parameters are confirmed.

## File-by-File Overview

### Core

- **`src/index.ts`** — Main entry point. Initializes all feeds, engine, storage, API server, and Telegram. Wires event handlers. Sets up periodic storage writes and status logging.

- **`src/config.ts`** — Environment variable loader. Reads from `.env` for API keys, Telegram credentials, alert thresholds, retention settings.

- **`src/types.ts`** — TypeScript interfaces for Trade, Liquidation, OrderbookSnapshot, HyperliquidContext, PolymarketData, VolatilityData, SafetyScores, DashboardState, AlertEvent.

### Feeds (`src/feeds/`)

All feeds emit events consumed by the VolatilityEngine.

- **`binance.ts`** — WebSocket connections to Binance Futures for: trade stream (aggTrade), orderbook (depth20@100ms), liquidations (forceOrder), and 1-minute klines. Parses and emits structured Trade, OrderbookSnapshot, and Liquidation objects.

- **`bybit.ts`** — WebSocket to Bybit for: trades, orderbook (depth 50), and liquidations. Same event interface as Binance. Includes ping/pong keepalive.

- **`hyperliquid.ts`** — REST polling (every 10s) of Hyperliquid's `metaAndAssetCtxs` endpoint. Returns funding rate, open interest (converted to USD via mark price), premium, 24h volume, and oracle/mark prices.

- **`polymarket.ts`** — REST polling for a specific Polymarket binary option token (if configured). Returns implied probability as a crowdsourced volatility estimate. Currently disabled (no token ID configured). Optional signal.

- **`coinglass.ts`** — REST polling for liquidation heatmap data (requires paid API key, $29/mo). Returns clustered liquidation levels above/below current price. Currently disabled (no API key). Optional signal.

### Engine (`src/engine/`)

- **`volatility.ts`** — **Core of the system.** ~520 lines. Key responsibilities:
  - Maintains rolling time-buffered arrays for ticks, trades (all, per-exchange), and liquidations
  - Calculates realized volatility from 1-minute log returns over 5/30/90 min windows, annualized
  - Computes P(drop > threshold) using normal CDF, then passes through calibration
  - Calculates CVD (cumulative volume delta), orderbook imbalance, taker buy ratio
  - Liquidation analysis: cascade risk classification (LOW/ELEVATED/HIGH/CRITICAL)
  - Composite danger score (0-100) combining vol, CVD, OB, liqs, funding, IV/RV spread
  - Per-operation safety scores (0-100) with signal-weighted penalties
  - Emits alerts on danger regime transitions
  - Provides full DashboardState including calibration context (hourly risk, suggestion)

- **`calibration.ts`** — **Probability calibration derived from 90-day backtesting (validated at 180 days).** The raw normal CDF model systematically under-predicts failure rates (crypto has fat tails). This module provides:
  - Piecewise linear interpolation tables mapping raw → observed failure rates per operation
  - Hourly risk multipliers (UTC) — 14:00-18:00 UTC is ~2x more dangerous (US market hours)
  - Helper functions: `calibrateProb()`, `getHourlyRiskLevel()`, `getSuggestedOp()`
  - Calibration data points derived from backtesting 260K 1-minute candles

- **`telegram.ts`** — Simple Telegram bot message sender. Sends formatted alerts via Bot API.

### Storage (`src/storage/`)

- **`db.ts`** — SQLite persistence via `better-sqlite3`. Stores:
  - `ticks` — ETH price snapshots
  - `trades` — Individual trade records with exchange, side, size
  - `liquidations` — Liquidation events
  - `indicators` — Periodic snapshots (every 30s) of all computed values
  - `alerts` — Triggered alert records
  - Automatic cleanup of data older than 30 days (configurable)
  - WAL journal mode for concurrent read/write
  - Prepared statements initialized via `prepareStatements()` method (not class field initializers — this was a critical fix for a runtime crash)

### API (`src/api/`)

- **`server.ts`** — Fastify server with:
  - `GET /` — Serves static dashboard HTML
  - `WS /ws` — WebSocket endpoint broadcasting full DashboardState every 1 second
  - `GET /api/state` — Current state snapshot
  - `GET /api/indicators?since=<ms>` — Historical indicator data
  - `GET /api/alerts?since=<ms>` — Recent alert history
  - `GET /api/health` — Health check

### Frontend (`public/`)

- **`index.html`** — Single-file dashboard (~29KB). Dark theme, monospace terminal aesthetic. Connects to VPS WebSocket, renders all panels: operation safety scores with calibrated P(fail), ETH price, composite danger gauge, volatility regime, CVD chart, orderbook imbalance, liquidation analysis, Hyperliquid context, heatmap placeholder, alert feed, and footer status bar. Includes suggestion bar showing hourly risk level and recommended operation. All rendering is vanilla JS, no framework.

### Backtesting (`src/backtest/`)

- **`fetcher.ts`** — Downloads historical 1-minute ETH/USDT candles from Binance Futures free API. Paginates backward, deduplicates, caches to JSON file.

- **`engine.ts`** — Replays historical klines through the volatility model. For each sampled timestamp: calculates trailing realized vol, predicts P(fail) via normal CDF, checks whether ETH actually dropped beyond threshold in the forward window. Produces calibration buckets, regime breakdown, Brier score, hourly pattern analysis.

- **`run.ts`** — CLI runner. Usage: `npx tsx src/backtest/run.ts <days>`. Downloads data (or uses cache), runs all three operation backtests, prints formatted results, saves JSON.

### Config/Deploy

- **`ecosystem.config.js`** — PM2 process config. Fork mode, single instance, 256MB max memory, auto-restart.
- **`deploy.sh`** — VPS setup script (Node.js, PM2, SQLite, firewall).
- **`tsconfig.json`** — TypeScript config. `strict: false` (required to avoid excessive type assertions on API responses), `types: ["node"]`.

## Backtesting Results Summary

Tested across 30, 90, and 180 days of 1-minute ETH data. Key findings:

| Metric | Extortion | Arms | Drug |
|--------|-----------|------|------|
| 180d fail rate | 22.3% | 12.6% | 5.6% |
| Raw model prediction | 14.0% | 6.1% | 2.1% |
| Under-prediction ratio | 1.59x | 2.07x | 2.67x |
| Brier score (180d) | 0.1567 | 0.1020 | 0.0508 |

**The ratios are stable across all test periods** (30d/90d/180d), confirming the calibration corrections are structural, not regime-dependent. The calibration module corrects for this.

**Hourly pattern:** 14:00-18:00 UTC (US market hours) consistently shows 2-3x higher failure rates across all operations.

## Known Issues / Areas to Review

1. **Bybit CVD always shows 0** — Likely the trade stream doesn't tag buy/sell side correctly. Binance CVD works fine. Low priority since Binance is the primary liquidity source.

2. **`strict: false` in tsconfig** — Turned off to avoid casting every API response. Some feeds use `as any` for JSON parsing. Could be tightened with proper response type definitions.

3. **Normal CDF assumption** — The base probability model uses symmetric normal distribution. Crypto returns have negative skew and excess kurtosis (fat tails). The calibration module corrects this empirically but doesn't model the underlying distribution correctly. A Student-t or GEV distribution would be more theoretically sound.

4. **Safety score formula** — The penalty weights in `calcScores()` (CVD, OB, liq, funding sensitivity multipliers) were hand-tuned, not optimized against historical data. The calibration module corrects the final probability but the individual signal weights could be improved.

5. **Polymarket / Coinglass feeds** — Both currently disabled (no API keys configured). The dashboard shows placeholder text for these panels. Code is present but untested in production.

6. **Game parameters unconfirmed** — The 5min/30min/90min windows and 0.17%/0.71%/2.0% thresholds are estimates. Actual game parameters may differ. These are constants in `volatility.ts` (`THRESHOLDS` and `WINDOWS` at top of file) and `backtest/engine.ts`.

7. **WebSocket reconnection** — Binance and Bybit feeds don't have robust reconnection logic. If a WS drops, the feed goes silent. PM2 will eventually restart the whole process on crash but there's no graceful per-feed reconnection.

8. **No authentication** — The dashboard and API endpoints are publicly accessible. This is intentional (read-only, public market data) but worth noting.

## What to Look For in Review

- **Correctness of probability calculations** in `volatility.ts` (calcVol, calcDropProb, normCdf)
- **Calibration curve accuracy** in `calibration.ts` — do the interpolation tables and hourly multipliers look reasonable?
- **Edge cases** — what happens when feeds disconnect, when there's no data, when buffers are empty?
- **Memory leaks** — rolling buffers in VolatilityEngine, trade arrays, WebSocket client management
- **SQLite usage** — prepared statement lifecycle, WAL mode, concurrent access patterns
- **Security** — any exposure through the API, WebSocket, or Telegram integration
- **TypeScript issues** — anything that `strict: true` would catch that could cause runtime errors

## Tech Stack

- Runtime: Node.js 20+ with TypeScript (compiled via `tsc`)
- Server: Fastify with `@fastify/websocket` and `@fastify/static`
- Database: SQLite via `better-sqlite3`
- Process manager: PM2
- Frontend: Vanilla HTML/CSS/JS (single file)
- No external framework dependencies in frontend
