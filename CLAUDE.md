# CLAUDE.md — Offshore Protocol Trading Bot

> **Project**: Personal trading bot + monitoring dashboards + Telegram alerts service
> for the on-chain game **Offshore Protocol** on MegaETH.
>
> **Operator**: `0x30C620cf1fbC38083FfE2c645Fb45d7FE487e194` (@rustyrocket on TG, ID `1051801606`).
> Hong Kong (HKT, UTC+8) — all schedules HKT-aware.
>
> **Source of truth for game mechanics**: <https://www.offshoreprotocol.fun/llms.txt>
> Always re-fetch this file before answering anything game-mechanical that isn't
> already covered here. Use `WebFetch` or `curl`. The page is the canonical doc;
> do not invent mechanics.

---

## ⚠️ HARD RULES (read first, every session)

1. **NEVER assume game mechanics, asset stats, or numbers.** If you don't know,
   look it up in `https://www.offshoreprotocol.fun/llms.txt`. If still unclear,
   **ASK THE OPERATOR** before doing anything.
2. **NEVER assume the operator's portfolio state.** Pull the dashboard
   (`http://localhost:3456/api/state`) or query the chain directly. Don't say
   "I think you have X" — verify.
3. **NEVER touch the operator's main wallet key** beyond what the bot already
   does (`enableAutoTrade`, `disableAutoTrade`, `startTrade`, `completeTrade`,
   `claimRewards`). Key lives in `.env` as `MAIN_KEY`. Do not log/print/expose it.
4. **Extortion (mode 0) is OPERATOR-CONFIRMED ONLY.** Single approved entry
   point: `/bot burn-money confirm` in TG, which engages the dedicated
   `burn-money` preset for a hard-capped 30 minutes and auto-reverts. The
   schedule lookup explicitly skips `burn-money` even if a corrupt config
   tries to use it. Live Ext threshold is sampled from chain (was 0.039%;
   weekend-mode ~0.0242%).
5. **Notify the operator** if anything drifts: bot key fails, schedule tx
   rejected, doc page changes, dependency vuln found, etc. Don't silently
   work around problems.
6. **The operator's goal is ROI**. They invested real money and want to maximize
   USDm return. Every recommendation should be in service of that. Hoarding
   for hoarding's sake is bad; reinvestment compounds.
7. **Two-Claude workflow.** Discussion/analysis happens in chat (this file's
   reader). Code execution / file writes / on-chain queries happen in **Claude
   Code**. When implementation work comes up here, prepare a brief and hand
   off — don't dump large code blocks in chat.

---

## 🎮 Game mechanics (CONDENSED — full source: llms.txt)

### Three interlocking systems
1. **Offshore Network** — Spend INF → run ops → earn $DIRTY
2. **Enterprise** — Spend $DIRTY → buy assets → build laundering loadouts
3. **Swiss Vault** — Loadouts auto-launder cash → earn USDm pro-rata every 8h

### The flywheel (THE dominant strategy per docs)
```
USDm → buy Influence → run ops → earn DIRTY → buy assets / level Status
  ↓                                                                     ↑
  ←─────  claim USDm pro-rata at end of 8h cycle  ←────  Swiss Vault  ←─
```
> Per docs: *"The dominant strategy is to reinvest USDm into Influence every
> 8-hour cycle."* Idle USDm = giving up share. Opening week pool is **>$100K USDm
> distributed pro-rata** — early reinvestment compounds harder.

### Operations (Offshore Network)
| Op | Duration | Liq. Threshold (weekday) | Reward (PL1) | Volatility tolerance |
|---|---|---|---|---|
| Extortion | 5 min | **0.039%** | 100 DIRTY (binary) | Worst — DISABLED by default |
| Arms deal | 30 min | **0.176%** | 100 DIRTY (progressive) | Calm markets |
| **Drug deal** | 90 min | **0.518%** | 100 DIRTY (progressive) | Volatile markets — current meta winner |

**Weekend leverage** tightens thresholds ~40% (Drug ~0.31%, Arms ~0.11%, Ext ~0.024%).
Live values sampled every 10min via `OpParamsFeed` from `tradeInfo()` on active corps.

Reward grows with Power Level: PL1 = 100, PL2 = 115, PL3+ = 130 DIRTY/op.

**INF cost per op floats with $DIRTY price.** Was historically 5.0 INF; observed
~9.12 INF as of 2026-05-09. Live-sampled via `OpParamsFeed.infCostPerOp`.

### Power Level (Offshore progression)
| PL | Max Corps | XP Needed | DIRTY/op | Unlock Cost |
|---|---|---|---|---|
| 1 | 3 | 0 | 100 | Free |
| 2 | 6 | 700 | 115 | $65 |
| 3 | 9 | 3,600 | 130 | $250 |
| 4 | 12 | 22,000 | 130 | [REDACTED] |
| 5 | 15 | 30,000 | 130 | [REDACTED] |

XP per op: Extortion 0.8, Arms 2.5, **Drug 7.5**. +20 XP per corp purchase.

### Status (Legitimacy / Enterprise progression)
| Status | XP Needed | DIRTY Cost | Suspicion Tolerance | Cleaning Bonus |
|---|---|---|---|---|
| 1 | 0 | 0 | 60 | 0% |
| 2 | 650 | 300 | 73 | 1% |
| **3** | **1,950** | **800** | **86** | **3%** |
| 4 | 3,900 | 1,500 | 100 | 6% |
| 5 | 6,500 | 2,500 | 113 | 10% |
| 6 | 10,400 | 4,000 | 126 | 15% |
| 7 | 15,600 | 9,000 | 140 | 21% |
| 8 | 23,400 | 13,500 | 153 | 28% |
| 9 | 35,100 | 19,500 | 166 | 36% |
| 10 | 52,000 | 28,500 | 188 | 46% |

XP sources: Asset purchase = 55, Cycle complete = **450**, Asset sell = 20.

### Enterprise loadouts
- **Up to 4 loadouts in S1** (each holds 6 assets, runs in Vault independently)
- L1: Day 1, no PL gate
- L2: Day 2, no PL gate
- L3: requires PL2
- L4: requires PL3
- An asset can only be in one loadout at a time

### Asset categories (one of each per loadout)
- **Business** — Cover business (primary: Cleaning Rate)
- **Insurance** — Protection (primary: Suspicion Tolerance)
- **Associates** — Connections (primary: Discretion / Bonus Chance)
- **Method** — Laundering technique (primary: Efficiency)
- **Accountant** — Optimizer (primary: Bonus Multiplier)
- **OpSec** — Privacy (primary: Suspicion Tolerance / Discretion)

### Asset stats (Common base values — multiply by rarity)
Rarity multipliers: Common ×1, Rare ×1.5, Epic ×2.5, Legendary ×4.5, Mythic ×8 (S2)

| Stat | Type | Effect |
|---|---|---|
| Cleaning Rate (CR) | Flat | Cash laundered per 30s tick |
| Suspicion Tolerance (ST) | Flat | Bonus to FBI heat capacity |
| Efficiency (Eff) | % | Reduces tick interval below 30s |
| Discretion (Disc) | % | Reduces suspicion per tick (CAP 70% combined) |
| Bonus Chance (BC) | % | Probability of bonus payout per tick |
| Bonus Multiplier (BM) | % | Size of bonus payout |

**Critical mechanic**: ALL output stats (CR, Eff, BC, BM) build suspicion faster.
The build tradeoff is Output vs Survival (ST + Disc).

### Swiss Vault
- 8-hour cycles, 30s ticks
- Every loadout enters automatically (Assets > 0)
- Cycle stops when FBI suspicion hits 100% OR cycle ends
- **Reward**: `Your USDm = (Your Cash Cleaned / Total Network) × Pool`
- Cycle pool funded by lost INF from failed ops, split 70/15/15 across 3 cycles
- Pool minus 3% protocol fee → distributed to players

### $DIRTY Token
- Uncapped supply, emitted via successful ops
- 0% team allocation (100% earned in-game)
- 50% sell tax first 24h after launch (already past)
- Uses: Asset packs (200 DIRTY each) and Status upgrades (300-28,500 DIRTY)

### Weekend Leverage Cycle (operator-confirmed 2026-05-09)
**Saturday 17:00 HKT → Monday 17:00 HKT** (48 hours/week). Saturday and Monday
are SPLIT days — half-weekday, half-weekend. Hour-aware classification lives in:
- `src/feeds/op-params.ts::isHktWeekend()`
- `src/feeds/schedule-evidence.ts::isHktWeekendHour(date, hour)`

The contract recalibrates leverage every ~48h independently of the weekend
cycle. Watch `op_params_history` for changes.

---

## 🤖 Bot architecture

### Project layout
```
src/
  index.ts              ← main entrypoint (wires all feeds + engines)
  config.ts             ← env-var driven config
  logger.ts             ← pino logger
  types.ts              ← DashboardState, AlertEvent, etc.
  utils/
    wallet-log.ts       ← walletLogTag() — privacy-safe wallet logging
  feeds/
    binance.ts          ← Binance WS (geo-blocked on this VPS, kept for failover)
    bybit.ts            ← Bybit WS (also blocked)
    hyperliquid.ts      ← HL REST (funding/OI/mark/oracle/volume)
    hyperliquid-ws.ts   ← HL WS — PRIMARY tick + trade + orderbook source
    onchain-balances.ts ← Polls INF/DIRTY/USDM via Multicall3
    corp-state.ts       ← Per-corp state (mode, autoTrade, cooldown, pendingClaim)
    amm-rate.ts         ← Live $DIRTY/USDM AMM via Uniswap V3 QuoterV2
    op-scraper.ts       ← Watches TC/TL events, writes to op_outcomes directly
    op-params.ts        ← Live threshold + INF/op sampling (10min poll). Also
                          isHktWeekend() — single source of truth.
    tokenomics.ts       ← DIRTY/INF/USDM supply, active player count
    polymarket.ts       ← (configured but no token ID set)
    coinglass.ts        ← (configured but no API key)
    kumbaya-price.ts    ← Kumbaya DEX $DIRTY price feed (5min, daily candles + 24h)
    kumbaya-lp.ts       ← Mint/Burn/Collect on DIRTY/USDM Univ3 pool
    loadout-scanner.ts  ← Enterprise loadouts: own (60s) + network meta + top 25 (15min).
                          Ranks by claim USDM (preferred) + ops (fallback). Computes topBySr.
    schedule-evidence.ts ← Daily HKT-hour SR rollups → network_hourly_stats. Now
                          regime-aware (weekday/weekend split).
    network-health.ts   ← Game-internal liq cascade detector (SHADOW mode)
    whale-trades.ts     ← Top-25 DIRTY transfers, classified by counterparty
    whale-claims.ts     ← CycleRewards claim event watcher
    whale-copy.ts       ← Top-5 by 72h SR — polls corps every 30s, emits copy events
    wallet-tracker.ts   ← Multi-tenant /api/track/:wallet — backs FlowDirty.fun
  engine/
    volatility.ts       ← Composite danger score, P(fail) via Student-t df=4
    economics.ts        ← EV calc per op type
    op-stats.ts         ← PAVA isotonic regression on empirical fail fractions
    op-summary.ts       ← Activity rollups (last1h/24h/sinceSession)
    distributions.ts    ← Normal/Student-t CDF helpers
    calibration.ts      ← 180-day backtest calibration
    eth-velocity-signal.ts ← Signed ETH ROC 5m/15m (SHADOW mode)
    telegram.ts         ← Static alert sender (legacy; mostly replaced by tgbot)
    tgbot.ts            ← Bot service (commands + DMs + inline-keyboard menu)
    sub-poller.ts       ← Multi-tenant per-subscriber alerts
    broadcaster.ts      ← Channel alert observer + daily digest at 09:00 HKT
    corp-bot.ts         ← *** THE TRADING BOT *** (presets, schedule, copy-mode,
                          danger override, circuit breaker, lockcorp, grace)
  api/
    server.ts           ← Fastify + WS for dashboard
  storage/
    db.ts               ← SQLite (better-sqlite3, WAL mode)
public/
  index.html            ← Operator dashboard SPA (5 tabs)
flowdirty/
  index.html, track.html, terminal.html  ← Public privacy-hardened surface
  nginx-vhost.conf      ← Privacy-tightened nginx config (no logs, HSTS, CSP)
data/
  offshore.db           ← SQLite db (op_outcomes, bootstrap_log, whale_*, etc.)
  corp-bot-state.json   ← Persisted operator state (manual preset, locks, etc.)
  op-scraper-cursor.json ← Resume cursor for chain scanner
.env                    ← Secrets (gitignored, 600 perms)
ecosystem.config.js     ← PM2 config (process: offshore-terminal, mem cap 768M)
```

### CorpBot (`src/engine/corp-bot.ts`) — preset + schedule system

**Preset selection priority**:
1. **Circuit breaker** (≥2 corps liquidated in 5 min → force-pause for 30 min)
2. **burn-money auto-revert** (operator-confirmed; max 30 min hard cap)
3. **Manual override** (`/bot preset <name>` / `/bot off` / `/bot on` / `/bot copy on`)
4. **Danger override** (`dangerScore >= panicThreshold`, default 75) — hysteretic
5. **HKT schedule lookup** (when `scheduleEnabled === true`)
6. **Fallbacks**:
   - Schedule ON but slot empty/invalid → `all-drug` (defensive)
   - Schedule OFF → `paused` (changed 2026-05-09 — was `all-drug`, confused operators)

**Manual operator control surfaces:**
- `/bot off` — sets manual preset to `paused`. Calls `disableAutoTrade()` on
  every corp on the next tick. Unambiguous "stop trading."
- `/bot on` — releases the manual lock; schedule (or fallback) takes over.
- `/bot pause` / `/bot resume` — soft pause: stops bot WRITES but doesn't
  disable auto-trade at contract level. Different from `/bot off`!
- `/bot lockcorp <i|addr>` / `/bot unlockcorp <i|addr>` — permanent per-corp
  opt-out. Bot skips claims, mode switches, re-enables, and bootstraps for
  locked corps. Persisted across restarts.
- **Operator override grace** (default 5min, `BOT_OPERATOR_GRACE_MIN`): when bot
  sees `autoTradeEnabled=false` on a corp the active preset wants ON, it grants
  the operator a grace window before re-enabling. Set to 0 to disable.
- **Op stagger gate** (default 15min, `BOT_STAGGER_MIN`): when multiple corps
  are eligible to bootstrap simultaneously, only one bootstraps per stagger
  window. Decorrelates ETH wick exposure. EV-neutral, variance reducer.

**Circuit breaker** (default threshold = 2): reactive defense against rapid serial
liquidations. Watches OUR corps' liquidation events (filtered by address,
never market-wide). When ≥2 distinct corps liquidate within a 5-min rolling
window, force-pauses all corps for 30 min. Tunable via `/bot breaker config`.
Uses event TIMESTAMP (block-derived, not Date.now) so backfilled events on
restart can't spuriously trip it.

**Built-in presets:**
| Name | Modes | Use case |
|---|---|---|
| `all-drug` | all Drug | Active markets, weekend default |
| `all-arms` | all Arms | Calm markets — selectively per data |
| `mix-arms` | 2:1 Arms:Drug | Hedged calm |
| `mix-drug` | 2:1 Drug:Arms | Hedged active |
| `paused` | auto disabled | Dead zones — saves INF |
| `panic` | auto disabled | Danger override target |
| `burn-money` | all Extortion | OPERATOR-CONFIRMED only, 30min cap |
| `copy` | dynamic from queue | Whale copy-mode (see below) |

**Copy-mode** (shipped 2026-05-09):
- `/bot copy on` — mirrors top 5 wallets by 72h SR (≥75% SR, ≥50 ops min)
- Pool refreshes every 15min from `loadoutScanner.topBySr`
- Polls each pool whale's corps every 30s via Multicall3, detects
  `isTradeActive: false → true` transitions, emits copy events
- CorpBot pops events from queue and bootstraps free corps in the same mode
- Auto-disables if our last-20 copy SR drops below network rolling SR
- Safety check: requires ≥10 resolved copies before trusting the comparison
- Outcomes attached to `whale_copy_log` via op-scraper join

**Strategy attribution** (shipped 2026-05-09):
- Every successful `startTrade()` writes a `bootstrap_log` row tagged with the
  active preset label (`auto:all-drug`, `manual:copy`, `breaker:paused`, etc.)
- Op-scraper joins outcomes to bootstraps on (corp, ts within 95min)
- `op_outcomes` columns: `strategy`, `corp`, `inf_cost`
- `/api/strategy-attribution?hours=N` returns per-strategy SR + DIRTY/INF + baseline
- Dashboard panel on OPS tab with 24H/7D/30D windows
- **Use this to retire underperforming strategies — the empirical test for
  whether copy-mode / Arms slots / panic preset are actually paying off.**

**Default HKT schedule** (v2 — May 8 2026, evidence-derived):
```
00h     →  all-drug     04-08h  →  all-drug     14h     →  all-arms (data: only Arms-clean hour)
01h     →  all-drug     09h     →  all-arms     15-16h  →  all-drug
02h     →  all-drug     10-13h  →  all-drug     17h     →  all-arms ⭐ v2
03h     →  all-arms ⭐  14h     →  all-arms     18h     →  all-arms ⭐ v2
                                                 19-20h  →  all-drug
                                                 21-22h  →  paused
                                                 23h     →  all-drug
```

**⚠ The Arms slots may need re-evaluation.** Live 24h global data (2026-05-09,
weekend regime) shows: Drug 80% SR / Arms 58% / Ext 60%. Top 12 SR wallets all
run 100% Drug. The schedule v2 was built on weekday data + the assumption that
"Arms in calm hours wins on cycles/hr". Both assumptions need to be re-tested
against the strategy attribution panel after a few days.

**Likely correct answer**: regime-aware schedule with separate weekday/weekend
arrays. Weekday gets selective Arms slots, weekend gets all-drug everywhere.
Infrastructure exists (`isHktWeekend()` + regime split in schedule-evidence)
but corp-bot's `this.schedule[24]` is still single-array. ~20 lines to wire up.

### Defense v2 — shadow-mode signals
All three signals **DEFAULT TO SHADOW MODE** (compute & log only, no bot pause).
Flip via env vars once `defense_shadow_log` shows good precision/recall:
- `NETWORK_HEALTH_SHADOW=false` enables NetworkHealthFeed bot pauses
- `ETH_VELOCITY_SHADOW=false` enables EthVelocitySignal bot pauses
- `SAFETY_GATE_SHADOW=false` enables per-op SafetyGate blocks

| Signal | What it watches | Trip condition |
|---|---|---|
| `NetworkHealthFeed` | Game-internal liq cascade (TL events network-wide) | ≥X liqs in 5min, drug-specific or all-types |
| `EthVelocitySignal` | Signed ETH return-on-change | Down-velocity threshold breach |
| `SafetyGate` | Per-op-type safety score (calibration model) | Score < per-op threshold |

Defaults (in `config.ts`):
- `safetyGateDrugThreshold: 50` (modest gate)
- `safetyGateArmsThreshold: 0` (OFF until more data)
- `safetyGateExtThreshold: 0` (OFF — Ext is operator-confirmed only anyway)

### Telegram admin GUI (operator-only via `TG_OPERATOR_CHAT_ID`)
- `/menu` or `/bot` (no args) — opens inline-keyboard GUI
- Buttons: 📊 Status · 💰 Wallet · 🎯 Presets · 📅 Schedule · 🔌 Breaker · ⚙️ Config · 💸 Claim · ⏸ Pause · 📋 Logs · 🔄 Refresh
- All actions navigate via `editMessageText` (no message spam)
- Operator-auth check on every `callback_query`

### TG text commands (operator-only)
- `/bot help` — full subcommand list
- **State**: `/bot` · `/bot logs` · `/bot claim`
- **Stop / start**: `/bot off` · `/bot on` · `/bot pause` · `/bot resume`
- **Per-corp**: `/bot lockcorp <i>` · `/bot lockcorp list` · `/bot unlockcorp <i>`
- **Presets**: `/bot preset list` · `/bot preset <name>` · `/bot preset auto` · `/bot custom <m1>...<mN>` · `/bot drug` · `/bot arms`
- **Schedule**: `/bot schedule` · `/bot schedule on|off` · `/bot schedule <range> <preset>`
- **Thresholds**: `/bot thresholds <high> <low>` · `/bot panic <threshold>`
- **Circuit breaker**: `/bot breaker` · `/bot breaker clear` · `/bot breaker config <W> <T> <C>`
- **Copy-mode**: `/bot copy on` · `/bot copy off` · `/bot copy status`
- **Burn-money**: `/bot burn-money` (shows live params + asks confirm) · `/bot burn-money confirm`

### Security audit status (passed by Codex CLI)
- ✅ MAIN_KEY format-validated before ethers; init errors don't leak the key
- ✅ Tick reentrancy guard, raw wallet (no NonceManager — see lesson #11)
- ✅ Async shutdown waits up to 30s for in-flight tx
- ✅ DM cooldown buckets (per corp + kind, 60s default)
- ✅ Strict integer regex on `TG_OPERATOR_CHAT_ID`
- ✅ `npm audit` reports 0 vulnerabilities
- ✅ Bot can ONLY call `enableAutoTrade(uint8)`, `disableAutoTrade()`,
  `startTrade(uint8)`, `completeTrade()`, `claimRewards()` on hardcoded corp addresses
- ✅ State persistence (data/corp-bot-state.json) survives pm2 restart with
  manual preset, locked corps, breaker tunables, schedule on/off

---

## 🏗 Operator state (UPDATE on every relevant turn)

> **VERIFY BEFORE QUOTING**: pull `http://localhost:3456/api/state` or query
> chain directly. Don't trust this section if it's older than the conversation.

### Wallet: `0x30C620cf1fbC38083FfE2c645Fb45d7FE487e194`
- Latest snapshot: see `/bot` or dashboard
- **Net deposit on protocol** (per 2026-05-09 scan): ~$1,239 USDm
  - For context: top 3 spenders deposited $36K-$47K each (30-40× operator)

### Game progression (last known — May 9 2026)
- **Power Level**: 2 ✅ (unlocked May 7 for $65 USDM)
- **DIRTY per op**: 115 at PL2
- **Legitimacy / Status**: 3 ✅ (XP ~1,265/3,900 → S4 needs ~2,635 more XP + 1,500 DIRTY)
  - Status 3 unlocked: +13 base sus tolerance (73→86), +2pp cleaning bonus,
    drop rates 65/24/9/2 → 58/26/13/3
- **Active corps**: 6 (3 Caribbean L1 + 3 L2) — all bot-managed
- **L3 corps**: 3 pre-deployed but locked behind PL3
  (3,600 XP + $250 unlock + 3×$75 corp fees ≈ $475 total)
- **Loadouts**: 2 active (E1 + E2). L3 still locked despite PL2 — likely day-gated.
- **Inventory**: ~16-19 items (varies as user buys/sells packs)
- **Notable assets**: 3 Legendaries (IRS Mogging Method, Memecoin Washtrading
  Method, Trump Associates) + 1 Epic (Shell Company Expert) + a few Rares
- **🚨 Mystery**: `balanceOf(presaleSbt, operator) = 0` despite Kingpin bundle
  ($490) purchase. Either wrong contract, different wallet, or claim flow not
  yet completed. Worth investigating.

### Loadout 1 stats (last shown)
| Field | Value |
|---|---|
| Cleaning Rate | 110 |
| Reputation | 98 |
| Eff | 147% |
| BC | 10.5% |
| BM | 110% |
| Disc | 28% |
| Survival | 33% |
| Est. cycle output | 54.84M |

**Bottleneck: SURVIVAL.** Discretion has 42pp of headroom (cap 70%).

### On-chain contracts (MegaETH) — full registry
| Contract | Address | What it does |
|---|---|---|
| DIRTY (ERC-20) | `0xc2f34f8849a8607fd73e06d6849bda07c2b7de38` | Main reward token |
| INF (ERC-20) | `0x403de0893f0bc66139592ba2fd254672f2db933a` | Operation fuel |
| USDM (ERC-20) | `0xfafddbb3fc7688494971a79cc65dca3ef82079e7` | Stablecoin reward |
| OSBT (ERC-721) | `0x943b75c86b83b8125d8e2b56d15fd30e8e1a0e74` | Presale SBT |
| User Factory | `0x619814a203ca441611cee02abf31986ca265dd35` | `getUserCompanies(addr)` returns 9 corp slots |
| Game proxy | `0xcd8e5aaee73730347d8a3568d57510158a07b4a6` | configRegistry |
| Corp beacon | `0x9fd0f6bb79547c8a2d4f3a625a8de6abfcc5f55b` | corp impl beacon |
| **Generator Manager** | `0x1b5AB7c503C2B1D94e7C42b212b4F944F7c77fce` | Enterprise/loadout state |
| Gacha | `0x1bf6ef01ADDb0181634370314aC6ee843d4A1c5E` | Asset packs (200 DIRTY each) |
| Swiss Vault | `0x955a4adDc17114C36726c12af9c73E23E497c2bD` | 8h auto-laundering |
| Cycle Rewards | `0x8C73Cd3BB0bFB577D4578bB075640C1eCc5027c8` | USDm claim contract |
| Trade Router | `0xF9f676066eB7BaEEED93E859BC26a41663F277A8` | Routes trade exec |
| Account Manager | `0xB0f8243e20a531b0A32bd5270A34eA18c7C4b68e` | Per-user state |
| Faction Staking | `0x3620bbEDED3BcF1b3409098Dc152b0EEcf66eA8e` | Faction system |
| QuoterV2 (Univ3) | `0x1F1a8dC7E138C34b503Ca080962aC10B75384a27` | DIRTY/USDM AMM quotes |
| Kumbaya pool | `0x6bD9eeF21c2419FeffafbF4850153A3b3A74A5E1` | DIRTY/USDM Univ3 pool |
| Multicall3 | `0xca11bde05977b3631167028862be2a173976ca11` | Batch RPC reads |

### Active corp addresses
| Index | Address | Region | Bot-managed |
|---|---|---|---|
| 0 | `0x60290db367cb46f3b0c1b439dbc0fed86aa24f90` | L1 Caribbean (Cayman) | ✅ |
| 1 | `0x2d6fb5a377d0a6d463c3aea17973609659afd0f0` | L1 Caribbean (BVI) | ✅ |
| 2 | `0x5f1b5afbbf9bed706d1806326479ddd36c8eec4a` | L1 Caribbean (Bermuda) | ✅ |
| 3 | `0x103469af1609c2341ae313e6fbfaab56022faa1a` | L2 region | ✅ |
| 4 | `0x35ebd95455aae47b66b4baf10654c34898aefa67` | L2 region | ✅ |
| 5 | `0x67aee1ca6e9b37ccfcbb9d62efd8a6a3f32db49f` | L2 region | ✅ |
| 6 | `0xf3bbfb854d57abf0cdda5b2a5219f5e2ca026c85` | L3 region | ⛔ locked, PL3 |
| 7 | `0xd9552288607fec4c113372f38f78347a050b60de` | L3 region | ⛔ locked, PL3 |
| 8 | `0x1e99791a6bd597ff892e0c6ae405b440aa582c7c` | L3 region | ⛔ locked, PL3 |

### Corp contract write functions (Ownable)
- `enableAutoTrade(uint8 mode)` — sets auto flag + mode
- `disableAutoTrade()`
- `startTrade(uint8 mode)` — bootstraps the FIRST trade. Required for newly-activated
  corps; auto-restart only fires AFTER an initial startTrade exists.
- `completeTrade()` — finalizes a finished trade. Without this, finished trades
  sit in limbo and contract NEVER auto-restarts.
- `claimRewards()` — transfers pending DIRTY to owner.
- `liquidate()` — called by oracle, not us.

**Bot tick logic**:
1. Read state (`autoEnabled`, `mode`, `isActive`, `isCompletable`, `cooldownEnd`) in one Promise.all
2. If `lockedCorps.has(addr)` → skip entirely
3. If `hasPendingClaim` → `claimRewards()`
4. If `isCompletable` → `completeTrade()` (triggers auto-restart)
5. If paused preset → `disableAutoTrade()` if currently on
6. If `!autoEnabled` → check operator-grace, then `enableAutoTrade(targetMode)`
7. If `autoEnabled && !isActive && cooldownPassed` → check stagger gate +
   safety gate, then `startTrade(targetMode)` (bootstrap). Copy-mode pulls
   targetMode from queue here.
8. If mode mismatch → `enableAutoTrade(targetMode)` (skipped under copy-mode)
9. Persist `bootstrap_log` row on every successful `startTrade`

---

## 📊 Dashboard

Operator dashboard at `offshore.lekker.design`. 5-tab layout:

- **⚡ OPS**: Corps, Wallet+Runway, Defense v2, Activity, **Schedule Evidence
  (with weekday/weekend regime toggle)**, Op cards, **Strategy Attribution
  (24H/7D/30D)**, Suggestion strip
- **📈 MARKET**: ETH price, Composite Danger, Vol Regime, Hyperliquid, CVD,
  Orderbook, Liquidations
- **💰 WALLET**: Wallet+Runway, $DIRTY price (Kumbaya history)
- **🏢 ENTERPRISE**: My Loadouts, Asset Meta
- **🌐 NETWORK**: Vault Claims, Kumbaya LP, Whale Stance, Whale Trades,
  Tokenomics, Whale Watch, Top SR

State persisted via `localStorage['offshore-active-tab']`.

---

## 🌐 FlowDirty.fun — public surface

Free anonymous wallet tracker + market terminal at `flowdirty.fun`. Mission:
**grow the network → grow the Vault denominator → grow operator's claim**.

### Privacy contract (MUST stay true)
- **Read-only.** No write paths from public routes. No wallet-connect.
- **Wallet addresses never persisted to disk.** Verified by:
  - `disableRequestLogging: true` on Fastify + redacting `serializers.req`
  - `walletLogTag()` everywhere wallets touch logs
  - nginx `access_log off; error_log /dev/null crit;` on `/api/track/*`
  - Rate limiter stores sha256 prefixes, never raw wallet/IP joins
- **Cleared from memory after 30s.** `WalletTracker.cache` schedules an
  unref'd setTimeout at TTL.

### Why we DON'T denylist the operator's wallet
The first audit suggested rejecting `config.walletAddress` on `/api/track/:wallet`.
**Decision: not implementing.** Reasoning:
1. Data is public on-chain — blocking on FlowDirty doesn't add privacy.
2. A denylist creates an **ownership tell** — the one address that 404s confirms
   operator ownership. Denying nothing is more anonymous.
3. The operator wants to use their own tracker.

---

## 🛠 Operations playbook

```bash
# Restart the bot
cd /home/muffinman/Offshoreprotocol
npm run build && pm2 restart offshore-terminal --update-env

# Tail bot logs
pm2 logs offshore-terminal | grep CorpBot

# Pull live state
curl -s http://localhost:3456/api/state | python3 -m json.tool | head -50

# Strategy attribution (per-strategy SR + DIRTY/INF over a window)
curl -s 'http://localhost:3456/api/strategy-attribution?hours=168' | python3 -m json.tool

# Schedule evidence with regime split
curl -s 'http://localhost:3456/api/schedule-evidence?regime=split' | python3 -m json.tool

# Quick op stats
node -e "
const Database = require('/home/muffinman/Offshoreprotocol/node_modules/better-sqlite3');
const db = new Database('/home/muffinman/Offshoreprotocol/data/offshore.db', { readonly: true });
console.log(db.prepare('SELECT op_type, COUNT(*) n, AVG(dirty_earned) avg FROM op_outcomes GROUP BY op_type').all());
"

# Rerun security audit
codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox < /tmp/audit-prompt.md
```

---

## 🔄 Maintenance triggers

When any of these happen, **update this file**:
- Power Level changes → progression table
- Status changes → progression + recompute affordability
- New corp deployed (PL2/PL3 unlock) → corp table; wire into CorpBot list
- New legendary asset acquired → re-evaluate loadout
- Loadout 3/4 unlocks → tell user, build allocator if wanted
- llms.txt content changes → re-fetch and reconcile
- Schedule edits → update default HKT schedule section
- New TG command shipped → command list

If `WebFetch llms.txt` disagrees with this file, **trust llms.txt and update CLAUDE.md**.

---

## 📜 Conversation context lessons (don't repeat)

1. **Don't paste private keys in chat.** Operator puts secrets in `.env` via SSH.
2. **Don't read MetaMask asset borders as rarity colors blindly.** Operator
   correction: only specific assets are non-Common. Always ask if uncertain.
3. **The dash before "Est. Cycle Output" is a separator, NOT a negative.**
   Output is positive.
4. **Corp ownership cannot be transferred.** Corps are Ownable but the game
   contracts won't accept a new owner. Use main wallet key.
5. **Extortion is OFF-LIMITS by default.** Operator policy.
6. **Operator is in HKT (UTC+8)**. All schedules HKT-aware.
7. **Verify on-chain state before answering "do you have X"**. Don't guess.
8. **Opening week pool is >$100K USDm**. Time-pressure decisions matter
   more now than they will later.
9. **`enableAutoTrade` alone does NOT start the first trade.** Newly-activated
   corps require explicit `startTrade(mode)` to bootstrap. Auto-restart only
   fires AFTER an initial trade exists.
10. **`completeTrade()` must be called to finalize finished trades.** Without
    it, finished trades sit in limbo. Bot calls it whenever `isCompletable`.
11. **Don't use ethers `NonceManager` for serialized writes.** Causes desync
    + `NONCE_EXPIRED` errors. Tick reentrancy guard already serializes; raw
    wallet + per-tx RPC nonce fetch is simpler and reliable.
12. **The optimizer's brute-force can give bad advice if inventory is stale.**
    Formula matches in-game UI to ±0.01% (validated). But recommendations
    depend on what items the optimizer SEES at scan time. Always sanity-check
    predicted vs actual in-game numbers before recommending a swap. Constants:
    `totalTicks=900, cycleBaseDamage=3333, cycleOutputHeatCoeff=20,
    cycleDiscretionCap=7000 (70%), cycleDamageScale=10000`.
13. **The "Starter Business" (template 44, CR=1) is NOT a presale perk.**
    Most-equipped Business asset network-wide because half the field pulls it
    from a normal pack and never replaces it. Operator does NOT have one.
14. **Whales running all-Extortion: pool-capture math, not per-op EV.** At
    operator's 0.3% pool share, Ext loses ~$280/cycle. Breakeven needs ~0.93%
    pool share (3× larger Enterprise). PL3 unlock ($475) reduces breakeven
    to operator's current share. PL3 unlocks the whale strategy.
15. **Op-scraper backfill timestamps were a circuit-breaker bug.** Replays use
    REAL event timestamps now (block-derived); breaker drops events older
    than its window before counting.
16. **Loadout-scanner needs ~310MB RSS.** PM2 mem cap is 768M.
17. **MegaETH RPC payload limits.** Multicall3 batches above ~150 calls return
    "413 Payload Too Large". Keep ≤120 for getItem-style, ≤150 for lighter calls.
18. **TL `duration` field is time-to-liquidation, not configured op window.**
    Most TL durations don't fall in the 5/30/90 min ±20% bands. Cascade-all
    path still works; op-type granularity from TL alone is degraded.
19. **Calibration drift.** `probDrug` was reading ~74% vs network actual 50%
    at one point. Refit needed after accumulating new outcomes. Watch.
20. **Mint events of exactly 10 DIRTY are gacha reveal dust returns** — one
    per pack reveal. NOT op rewards (those are 100/115/130).
21. **`upgrade` side in `whale_trades` includes more than just Status burns.**
    Bulk pack purchases (4000 DIRTY = 20 packs × 200) are also classified as
    'upgrade' because the Gacha contract burns DIRTY on commit. Don't conflate.
22. **CREATE INDEX after ALTER TABLE migration.** SQLite can't `CREATE INDEX
    IF NOT EXISTS` on a column that doesn't exist on legacy DBs. New columns
    need their indexes created in the migration block, AFTER the ALTER runs.
23. **Weekend cycle is Sat 17:00 → Mon 17:00 HKT** (operator-confirmed
    2026-05-09). NOT all of Fri-Sun. Saturday and Monday are SPLIT days —
    hour-aware classification required, not just day-of-week.
24. **Top SR meta is currently 100% Drug.** All 12 top-SR wallets observed
    2026-05-09 run Drug-only configs. Drug 80% network SR vs Arms 58% vs
    Ext 60% in the 24h weekend snapshot. The current schedule's `all-arms`
    slots are likely -EV in this regime.
25. **SR ≠ claim earnings.** Claim share comes from Enterprise output, not
    op SR. Vault is a separate system. High-SR Drug runners earn modest
    claims unless they also scale Status + Assets.
26. **Whale binge pattern**: claim USDm → bulk-buy DIRTY on Kumbaya →
    burn 320+ packs in a single 10-min session → upgrade Status. Defensive
    move against pool-share dilution. Visible in `whale_trades` as
    sequential 4000-DIRTY upgrade events + a single large `buy`.
27. **INF refund-on-success is via mint-from-0x0, NOT a transfer in the TC tx.**
    Verified on chain 2026-05-10. The contract:
      • Burns the live INF cost (~9-12 INF, floats with $DIRTY price) at
        `startTrade()`.
      • Emits `TradeCompleted` on success (DIRTY accrues as `pendingReward`,
        no INF transfer in the same tx).
      • **~3 blocks after TC, mints the full INF stake back to the player**
        from the zero address. Player's net cost on a winning op = 0 INF.
      • On failure (`TradeLiquidated`), no refund — the burned INF stays
        burned. Player's net cost = full live INF cost.
    Consequences for the bot:
      • The right efficiency metric is `DIRTY earned / INF actually burned`,
        where INF burned = 0 on successes and `inf_cost` on failures.
        `op_outcomes` now stores both `inf_cost` (stake at risk, useful
        for treasury planning) AND `inf_burned` (net cost, the right
        denominator for DIRTY/INF).
      • Pre-fix (before 2026-05-10), every DIRTY/INF reading was understated
        by ~3× for high-SR strategies. Drug at 71.7% SR looked like 12.52
        DIRTY/INF; true value is ~33.1 (refund-aware).
      • As `P(fail) → 0` the formula yields `Infinity`. Renderers must
        check `Number.isFinite()` and display `∞ / no losses` instead of
        `Infinity.toFixed(2)`. Comparators rank Infinity at top.
      • The bot's TRADING DECISIONS were never tainted — corp-bot doesn't
        consume `economics.dirtyPerInf`. Only display + audit metrics
        were skewed.
    See `src/engine/economics.ts` and `src/engine/efficiency.ts` for the
    fix; `src/storage/db.ts` schema notes the `inf_burned` column.

---

## 🛠 Build queue (ranked by ROI)

1. **Regime-aware schedule** — split `corp-bot.ts::schedule[24]` into
   `scheduleByRegime: { weekday, weekend }`. Wire to `isHktWeekend()`.
   ~20 lines. Highest immediate ROI given the 16pp+ regime SR delta.
2. **Productionize the loadout simulator** as a dashboard panel — interactive
   "swap simulator" where operator picks 2 items to swap and sees predicted
   delta BEFORE committing on-chain. Currently lives at `/tmp/optimize2.py`.
3. **Per-op real-time EV widget** on OPS tab — given current danger score,
   show "Drug X DIRTY/op, Arms Y DIRTY/op" updated every second.
4. **Status / Power Level XP progress bars** — small widget showing distance
   to next milestone with DIRTY cost preview.
5. **Vault forward-pool estimator + denominator simulator** (Codex audit #1) —
   forecast the next 3 cycles' pool sizes + simulate every scanned loadout's
   cleaned cash to estimate the total network denominator. Turns asset/Status
   decisions into USDm/cycle EV. Codex ranked this as the highest-EV build.
6. **Whale equip-pivot detector** (Codex audit #5) — diff whale loadouts every
   15min, alert on large changes in projected output/survival. Detects meta
   shifts hours before claim data confirms them.
7. **Whale cash-intent classifier** (Codex audit #13) — split tracked whales
   into compounders / sellers / pack buyers / vault farmers. Improves
   copy-mode signal-to-noise.
8. **PL3 break-even calculator** (Codex audit #8) — settle the ongoing PL3
   timing question with a live calc.
9. **Investigate the missing presale SBT** — operator bought Kingpin but
   `balanceOf(presaleSbt, operator) = 0`.

---

## 🐛 Known issues / observations to verify

- After 23:00 HKT (when schedule exits the paused window), all 6 corps should
  be running ops. If any stay idle, the startTrade bootstrap may have edge cases.
- Latest `op-scraper-cursor.json` may have stale block reference — bot startup
  re-scans from cursor and could overwhelm RPC. Watch logs for batch failures.
- `network_hourly_stats` retention not set in cleanup() — table grows forever.
  Same for `defense_shadow_log`, whale tables, op_params_history. Decide TTLs
  before they bloat the DB.
- `getWhaleStance()` runs a full aggregate query every `getState()` broadcast
  (1Hz) — should be cached on a timer. Codex flagged this in cleanup audit.
- Top-12 SR wallets' op-type breakdown via TL duration was UNRELIABLE (TL
  duration is time-to-liquidation, not op window). Use current `autoTradeMode`
  via Multicall3 instead — see chat session 2026-05-09 for the correct pattern.
