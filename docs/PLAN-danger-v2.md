# Plan: Danger Score v2 — Composite Defense System

**Status:** Draft for operator review · 2026-05-08
**Author:** AI session @ 13:30 UTC
**Goal:** Replace the current single-axis vol-prediction `dangerScore` with a layered composite that combines lagging real-outcome confirmation + forward-looking velocity tripwires + structural rules. Each layer is independently shippable and revertible.

---

## 1. Why the current danger score is insufficient

Today's `dangerScore` (in `src/engine/volatility.ts`) is computed from CEX-derived inputs:
- Realized volatility (5m / 30m / 90m windows)
- CVD imbalance
- Orderbook depth asymmetry
- Hyperliquid funding rate
- CEX liquidation velocity (Binance + Bybit perp liqs)

It produces a 0–100 scalar that drives the panic override (`>=75` forces panic preset).

**Failure modes observed in the last 7 days of evidence:**

1. **Direction blindness.** ETH ripped UP through 14:00 HKT today; vol metrics fired but ops were perfectly safe (liquidations only happen on DOWN moves — confirmed by your one-sided-down headroom fix). Result: false-positive panic.
2. **CEX-not-game lag.** CEX liquidation velocity captures perp traders' pain; Offshore Protocol op failures aren't directly indexed. The 21:00 HKT bloodbath today (3% network SR, 2,544 ops, 95%+ failure rate) only registered in CEX liq velocity AFTER the cascade was half over.
3. **Single-venue funding noise.** Hyperliquid funding can flip during low-liquidity periods without genuine market signal. Cross-venue confirmation would filter this.
4. **No game-internal signal.** The single most predictive metric — *are other Offshore players' ops failing right now?* — isn't measured at all today.

---

## 2. Design principles

1. **Layer signals, don't replace.** Keep the existing `dangerScore` as one of N inputs. New signals are gates that can OVERRIDE the schedule independently.
2. **Forward + backward + structural.** Mix leading indicators (velocity), confirming indicators (real outcomes), and rules (op-type-aware schedule).
3. **Each layer independently revertible.** A bad new signal shouldn't break the system — feature-flag every layer.
4. **Op-type-aware throughout.** Drug (0.518%), Arms (0.176%), Extortion (0.039%) have wildly different risk profiles. Every signal that can be op-type-conditional should be.
5. **Never animate the bot blind.** Every new override must emit an alert (TG + dashboard) explaining WHY it fired, so the operator can audit.

---

## 3. Signals — implement / skip / extend

### A. NEW · `NetworkHealthFeed` — game-internal cascade detection ⭐ PRIORITY 1

**What it measures:** Real Offshore Protocol op outcomes, network-wide, classified by op type.

**Why now:** This is the canonical "are other people's Drug ops dying right now?" signal. We don't have this anywhere today. The schedule-evidence feed gives us *historical* hourly aggregates; this gives us *live* 5-min and 15-min rolling rates.

**Architecture:**

```ts
// src/feeds/network-health.ts
export interface NetworkHealthSnapshot {
  windowMs: number;                  // 300_000 (5min) typically
  scannedAt: number;
  totalCompleted: number;            // TC events in window
  totalLiquidated: number;           // TL events in window
  // Per-op-type liquidation rate (extortion classified by duration)
  liqDrug: number;
  liqArms: number;
  liqExtortion: number;
  // Velocities — first derivative across last 60s vs 5min average
  liqDrugVelocity: number;            // events/min (60s) — rate-of-change of failures
  liqArmsVelocity: number;
  liqExtVelocity: number;
  // Composite signals (already-computed for fast UI consumption)
  cascadeRisk: 'safe' | 'elevated' | 'critical';   // tied to velocity thresholds
  drugSpecificRisk: 'safe' | 'elevated' | 'critical';
}
```

**Polling:** every 60 seconds. Each tick scans only the last ~600 blocks (10 min) — cheap (1 RPC call per chunk × 1 chunk = 1 call). Maintains an in-memory ring buffer of TL events with timestamps so we can compute 60s/5min/15min windows on demand.

**Trigger thresholds (tunable):**
- `cascadeRisk = 'critical'` when `liqDrug + liqArms + liqExt > 50 in 5min` AND `(liqVelocity_60s > 3 × avgLiqRate_5min)` (ramping)
- `drugSpecificRisk = 'critical'` when `liqDrug ≥ 8 events in 5min` (calibrate against 7-day distribution)

**Wiring into CorpBot:**
```ts
// In pickActivePreset(), new override branch (between circuit breaker and danger):
if (state.networkHealth?.drugSpecificRisk === 'critical' && currentMode === 'drug') {
  return { preset: 'paused', reason: 'network-cascade-drug' };
}
if (state.networkHealth?.cascadeRisk === 'critical') {
  return { preset: 'paused', reason: 'network-cascade-all' };
}
```

**Files touched:**
- NEW `src/feeds/network-health.ts` (~130 lines)
- `src/types.ts` — add `networkHealth` to `DashboardState`
- `src/index.ts` — instantiate, wire to engine
- `src/engine/corp-bot.ts:pickActivePreset()` — new override branch + reason enum
- `src/engine/volatility.ts` — feed `networkHealth` into `engine.state`
- `public/index.html` — small panel showing live 5min SR + per-op velocities
- `src/engine/tgbot.ts` — TG alert on transition into/out of `critical`

**Effort:** ~3 hours. Files mostly copy-paste from `loadout-scanner` chain-scan logic.

**Validation plan:**
- Backtest against today's 21:00 HKT carnage. The 600-block scan would have caught liqVelocity ramping ~5 minutes BEFORE the cascade peaked. Force-pause at minute -5 saves ~12 ops × 5 INF = 60 INF.
- Run in shadow mode for 24h: log "would have paused" without actually pausing. Compare actual op outcomes against the shadow recommendations.

---

### B. NEW · ETH velocity (signed rate-of-change) ⭐ PRIORITY 2

**What you correctly pointed out:** vol exists; signed rate-of-change does not.

We have `volatility.vol5m` etc. (RV — variance), but no `ethVelocity = (price_now - price_60s_ago) / price_60s_ago × bps_per_min`. RV can't distinguish "ETH dropped 0.5% in 60s" (dangerous) from "ETH rose 0.5% in 60s" (safe). Liquidations only fire on the down move.

**Architecture:**

```ts
// In src/engine/volatility.ts (new method on existing engine)
function computeEthVelocity(priceHistory: { ts: number; price: number }[]): {
  velocity60sBps: number;       // negative = falling, in basis points / minute
  velocity300sBps: number;
  acceleration60sBps: number;   // 2nd derivative — ramping vs decelerating
} {
  // Linear fit over the 60s window; report slope normalized to bps/min
}
```

**Trigger:**
- `forcePause` when `velocity60sBps < -8` (ETH falling >8bps/min for the last minute) — that's a 0.5% drop over the next 60s if the slope continues, which exceeds Drug's 0.518% threshold
- `forcePause` when `velocity300sBps < -3` AND `acceleration60sBps < 0` (sustained AND accelerating fall)

**Wiring:** new override branch in `pickActivePreset`, between network-health and the existing danger-score override.

**Files touched:**
- `src/engine/volatility.ts` — add method + thresholds (~30 lines)
- `src/engine/corp-bot.ts:pickActivePreset()` — new override branch (~5 lines)

**Effort:** ~30 minutes. Uses existing `priceHistory` already maintained by HyperliquidWS feed.

**Validation:** backtest against today's 10:00 HKT wipe. ETH dropped sharply in that window. velocity60s would have fired ~30s BEFORE the first liquidations. Catches drops the network-health feed only sees after-the-fact.

---

### C. EXTEND · Cross-exchange funding signal ⭐ PRIORITY 5 (low EV, easy)

**Current state:** Hyperliquid funding only (`feeds/hyperliquid.ts`). HL has $50-100M open interest — meaningful but a single venue.

**Proposal:** add Binance USDM ETHUSDT funding + OKX ETH-USDT-SWAP funding via their public REST endpoints. Compute median funding across the three. Coingecko does NOT expose funding rates in their public API (verified). Coinglass does, but requires paid key (`config.coinglass` exists but no API key set).

**Sources to add:**
- **Binance**: `GET https://fapi.binance.com/fapi/v1/premiumIndex?symbol=ETHUSDT` (free, no auth, returns `lastFundingRate` and `markPrice`)
- **OKX**: `GET https://www.okx.com/api/v5/public/funding-rate?instId=ETH-USDT-SWAP` (free, no auth)
- **Bybit**: already in our feed but funding wasn't being pulled — add to existing feed
- **Coinglass**: skip unless we want to pay for the API key (quality-of-life, not critical)

**Trigger:** elevate danger when median funding flips sign rapidly (sign change in ≤2 hours) OR when funding hits extreme percentiles (top/bottom 1% of trailing 7-day distribution).

**Files touched:**
- NEW `src/feeds/funding-aggregator.ts` (~80 lines)
- `src/engine/volatility.ts` — replace `funding` field with median across venues + venue dispersion as a confidence score
- `src/types.ts`

**Effort:** ~2 hours. Most of it is REST plumbing + careful timezone handling on funding intervals (Binance is 8-hourly, OKX is 8-hourly with different anchor times).

**Note:** this is the LOWEST EV item on the list. Funding lags actual price moves; it's confirmation, not prediction. Ship after the others.

---

### D. KEEP · Existing CEX liquidation velocity

We already compute `liqVelocity` from Binance + Bybit perp liquidations. This is a market-cascade signal, complementary to the new game-internal `networkHealth.liqVelocity`. Both are useful — perp liqs often precede game liqs by 30–60s when ETH dumps.

No changes needed; just make sure the danger-v2 composite weights both.

---

### E. KEEP · Existing volatility (RV)

Realized volatility is fine as a *baseline* danger signal but should be downweighted now that we have signed velocity. Don't remove — it still catches edge cases where price chops violently in both directions without strong slope (whipsaws kill ops too).

---

### F. SKIP · ~~Cycle boundary blackout~~

**Operator correction accepted.** Vault cycles are an 8h epoch for laundering settlement; they don't affect op windows directly (ops are 5min / 30min / 90min and only depend on ETH price relative to anchor). My earlier suggestion was wrong. Removed from plan.

---

### G. NEW · Op spacing ⭐ PRIORITY 4

**What it does:** Stagger the 6 corps' op bootstraps by `STAGGER_MIN` (default 15min). Today they fire roughly simultaneously when their cooldowns clear, so a single ETH wick can take out all 6.

**Architecture:**

```ts
// In CorpBot, per-corp state:
private nextEligibleBootstrapTs: Map<string, number> = new Map();

// In tick(), before calling startTrade:
const slotIdx = corpAddrs.indexOf(corp);
const myStaggerMs = slotIdx * STAGGER_MS; // 0, 15min, 30min, ...
const eligible = (this.nextEligibleBootstrapTs.get(corp) ?? 0) <= now;
if (!eligible) continue;
// ... existing startTrade logic ...
this.nextEligibleBootstrapTs.set(corp, now + STAGGER_MS_TOTAL);
```

**Trade-offs:**
- ✅ EV-neutral (same total ops/day, same per-op SR distribution in expectation)
- ✅ ~17% reduction in within-salvo correlation for 90min Drug ops (15min/90min stagger)
- ✅ Smoother DIRTY income stream
- ⚠ Lower throughput recovery — if a corp completes early, it has to wait for its slot
- ⚠ More wall-clock idle if the bot pauses mid-cycle (some corps will have already missed their slot)

**Configurability:** Add `BOT_STAGGER_MIN` env var (default `0` = current behavior; set to `15` to enable). Keeps the change reversible.

**Files touched:**
- `src/engine/corp-bot.ts` — `nextEligibleBootstrapTs` map + tick logic (~50 lines)
- `src/config.ts` — `staggerMin` config

**Effort:** ~1.5 hours including testing.

---

### H. EXTEND · `dangerScore` becomes a composite output

The existing `dangerScore` (0–100) becomes the BLENDED OUTPUT of all these signals, not a primary signal itself. The actual force-pause logic uses individual hard-trip signals (above), not the composite.

**Proposal:**
```ts
dangerScore = clamp(0, 100,
  0.20 × volatility_normalized
  + 0.15 × cex_liq_velocity_normalized
  + 0.30 × game_liq_velocity_normalized      // NEW (network-health)
  + 0.20 × eth_velocity_normalized           // NEW (rate-of-change)
  + 0.10 × cross_funding_normalized          // NEW (multi-venue)
  + 0.05 × orderbook_imbalance_normalized
)
```

Used for: dashboard display, hourly directive, and a SOFT downgrade (e.g. `dangerScore > 60` switches all-arms to all-drug for the safer threshold even if no hard trip fired).

The HARD force-pause is still independent per-signal as described above.

---

## 4. Build order (recommended sequence)

| # | Item | Effort | EV Impact | Dependency |
|---|---|---|---|---|
| 1 | NetworkHealthFeed (op-type-aware) | ~3h | HIGH | None |
| 2 | ETH velocity (signed rate-of-change) | ~30m | HIGH | None |
| 3 | Composite `dangerScore` reweighting | ~30m | MED | After 1 + 2 |
| 4 | Op spacing | ~1.5h | MED | None (orthogonal) |
| 5 | Cross-exchange funding | ~2h | LOW | None |
| 6 | Dashboard "Defense" panel | ~1h | UI only | After all |

**Total: ~8.5 hours of focused work** spread across the layers. Each is independently shippable; ship in priority order, validate each in shadow mode for 24h before letting it actually force-pause.

---

## 5. Shadow mode (zero-risk validation per layer)

Every new force-pause signal gets a feature flag:

```ts
// .env
NETWORK_HEALTH_SHADOW=1     # log "would force-pause" but don't pause
ETH_VELOCITY_SHADOW=1
CROSS_FUNDING_SHADOW=1
```

In shadow mode the signal computes and logs to a new `defense_shadow_log` SQLite table:

```sql
CREATE TABLE defense_shadow_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  signal TEXT NOT NULL,         -- 'network_health' | 'eth_velocity' | ...
  would_pause INTEGER NOT NULL, -- 0/1
  reason TEXT NOT NULL,
  context_json TEXT
);
```

After 24h we cross-reference shadow events against actual `op_outcomes` to compute:
- `precision`: of times the signal would have paused, how often did the next op actually fail?
- `recall`: of all op failures in the window, how many were preceded by a pause signal?

Only flip `*_SHADOW=0` when both metrics exceed thresholds (e.g. precision > 60%, recall > 40%).

---

## 6. Alerting

Every force-pause emits ONE TG alert per transition (entering or leaving paused state). Format:

```
🛑 BOT FORCE-PAUSED — network-cascade-drug
  trigger: 12 Drug liqs in 5min (3× normal rate)
  next eligible: 14:23 UTC
  ack /bot resume to override
```

```
✅ BOT RESUMED — network-cascade-drug cleared
  Drug liq rate normalized (3 in last 5min, baseline 4)
  preset: all-arms (schedule)
```

No spam: cooldown bucket per signal type, 60s minimum between repeat alerts.

---

## 7. Failure modes & rollback

Each signal should be killable via env var without redeploy:

```
NETWORK_HEALTH_DISABLED=1
ETH_VELOCITY_DISABLED=1
CROSS_FUNDING_DISABLED=1
```

If something goes wrong (false-trips during normal markets), set the flag → restart pm2 → rollback complete. Source of truth for "what's currently live" is the `/bot status` TG output, which lists every active signal layer.

---

## 8. Open questions for operator

1. **Stagger interval (item G):** 15min default reasonable, or prefer 10min / 20min? Smaller = more diversification but also more "wait for slot" idle time.
2. **Network-health window (item A):** 5-min trigger window OR 10-min? 5min is faster but noisier on quiet hours; 10min is smoother.
3. **Shadow mode duration:** 24h sufficient before flipping to live, or want 72h?
4. **Funding venues:** Binance + OKX enough, or add Bybit too (we already pull Bybit price; would just add the funding endpoint)?
5. **Coinglass API key:** worth $30/mo for higher-quality liquidation aggregation, or skip?
6. **TG alerts:** want force-pause alerts to your operator chat ONLY, or also broadcast to a channel?

---

## 9. Out of scope (intentionally)

- Auto-claim USDM at cycle close (operator declined separately)
- Auto-reinvest USDm → INF (operator declined)
- ML-based op-type recommendation (premature — we don't have enough labeled data yet)
- Op spacing across DIFFERENT op types (i.e. 3 Arms + 3 Drug staggered) — possible future, not in this plan
