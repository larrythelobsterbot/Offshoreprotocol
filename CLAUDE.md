# CLAUDE.md — Offshore Protocol Trading Bot

> **Project**: Personal trading bot + monitoring dashboard + Telegram alerts service
> for the on-chain game **Offshore Protocol** on MegaETH.
>
> **Operator**: `0x30C620cf1fbC38083FfE2c645Fb45d7FE487e194` (@rustyrocket on TG, ID `1051801606`)
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
   does (`enableAutoTrade`, `disableAutoTrade`, `claimRewards`). The key lives
   in `.env` as `MAIN_KEY`. Do not log it, print it, expose it.
4. **Extortion (mode 0) is OPERATOR-CONFIRMED ONLY.** Never add it to a
   schedule slot, never make it the default, never let `/bot drug` /
   `/bot arms` / `/bot custom` / `forceMode()` accept mode 0. The single
   approved entry point is `/bot burn-money confirm` in TG, which engages
   the dedicated `burn-money` preset for a hard-capped 30 minutes and
   auto-reverts. The schedule lookup explicitly skips `burn-money` even if
   a corrupt config tries to use it. Live Ext threshold is sampled from
   chain (was 0.039%; weekend-mode 0.0242%).
5. **Notify the operator** if anything drifts: bot key fails, schedule tx
   rejected, doc page changes content, dependency vuln found, etc. Don't
   silently work around problems.
6. **The operator's goal is ROI**. They invested real money in a "ponzi game"
   and want to maximize USDm return. Every recommendation should be in service
   of that. Hoarding for hoarding's sake is bad; reinvestment compounds.

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
| Op | Duration | Liquidation Threshold | Reward (PL1) | Volatility tolerance |
|---|---|---|---|---|
| Extortion | 5 min | **0.039%** | 100 DIRTY (binary) | Worst — DISABLED |
| Arms deal | 30 min | **0.176%** | 100 DIRTY (progressive) | Calm markets |
| **Drug deal** | 90 min | **0.518%** | 100 DIRTY (progressive) | Volatile markets |

Reward grows with Power Level: PL1 = 100, PL2 = 115, PL3+ = 130 DIRTY/op.

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
| 7+ | up to 52,000 (S1) | up to 28,500 | up to 188 | up to 46% |

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
Rarity multipliers: Common ×1, Rare ×1.5, Epic ×2.5, Legendary ×4.5, Mythic ×8

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
- Uses: Asset packs (200 DIRTY each) and Status upgrades (300-70k DIRTY)

---

## 🤖 Bot architecture

### Project layout
```
src/
  index.ts              ← main entrypoint (wires all feeds + engines)
  config.ts             ← env-var driven config
  logger.ts             ← pino logger
  types.ts              ← DashboardState, AlertEvent, etc.
  feeds/
    binance.ts          ← Binance WS (currently geo-blocked on this VPS)
    bybit.ts            ← Bybit WS (also blocked)
    hyperliquid.ts      ← HL REST (funding/OI/mark/oracle/volume)
    hyperliquid-ws.ts   ← HL WS — PRIMARY tick + trade + orderbook source
    onchain-balances.ts ← Polls INF/DIRTY/USDM via Multicall3
    corp-state.ts       ← Per-corp state (mode, autoTrade, cooldown, pendingClaim)
    amm-rate.ts         ← Live $DIRTY/USDM AMM via Uniswap V3 QuoterV2
    op-scraper.ts       ← Watches TradeCompleted/TradeLiquidated events
    tokenomics.ts       ← Tracks DIRTY/INF/USDM supply, active player count
    polymarket.ts       ← (configured but no token ID set)
    coinglass.ts        ← (configured but no API key)
    kumbaya-price.ts    ← Kumbaya DEX $DIRTY price feed (5-min poll, daily candles + 24h)
    loadout-scanner.ts  ← Enterprise loadouts: own (60s) + network meta + top players (15min)
  engine/
    volatility.ts       ← Computes danger score, P(fail) via Student-t df=4
    economics.ts        ← EV calc per op type
    op-stats.ts         ← PAVA isotonic regression on empirical fail fractions
    op-summary.ts       ← Activity rollups (last1h/24h/sinceSession)
    distributions.ts    ← Normal/Student-t CDF helpers
    calibration.ts      ← 180-day backtest calibration
    telegram.ts         ← Static alert sender
    tgbot.ts            ← Bot service (commands + DMs)
    sub-poller.ts       ← Multi-tenant per-subscriber alerts
    broadcaster.ts      ← Channel alert observer
    corp-bot.ts         ← *** THE TRADING BOT *** (presets, schedule, danger override)
  api/
    server.ts           ← Fastify + WS for dashboard
  storage/
    db.ts               ← SQLite (better-sqlite3, WAL mode)
public/
  index.html            ← Dashboard SPA
data/
  offshore.db           ← SQLite db (op_outcomes, subscribers, etc.)
  op-scraper-cursor.json ← Resume cursor for chain scanner
.env                    ← Secrets (gitignored, 600 perms)
ecosystem.config.js     ← PM2 config (process: offshore-terminal)
```

### CorpBot (`src/engine/corp-bot.ts`) — preset + schedule system

**Preset selection priority**:
1. **Circuit breaker** (≥2 corps liquidated in 5 min → force-pause for 30 min)
2. **burn-money auto-revert** (operator-confirmed; max 30 min)
3. Manual override (`/bot preset <name>` / `/bot off` / `/bot on`) — locks until released
4. Danger override (`dangerScore >= panicThreshold`, default 75)
5. HKT schedule lookup (when `scheduleEnabled === true`)
6. **Fallbacks** (changed 2026-05-09):
   - Schedule ON but slot is empty/invalid → `all-drug` (defensive)
   - Schedule OFF → **`paused`** (was `all-drug` until 2026-05-09 — operator
     reported confusion: turning schedule off didn't stop trading.)

**Operator commands worth knowing:**
- `/bot off` / `/bot stop` — sets manual preset to `paused`; calls
  `disableAutoTrade()` on every corp on the next tick. Unambiguous "stop trading."
- `/bot on` — releases the manual lock so the schedule (or fallback) takes over.
- `/bot pause` / `/bot resume` — toggles `operatorPaused`. Stops the bot's WRITES
  but does NOT disable on-chain auto-trade. If auto was already enabled, the
  contracts keep running ops on their own. Different from `/bot off`!
- `/bot schedule off` — disables the time-of-day schedule. Now falls back to
  `paused`, so this also stops trading. Use `/bot schedule on` to resume.

**Circuit breaker** (default threshold = 2, was 3): reactive defense against rapid
serial liquidations (the "fast death loop"). Watches `OpScraperFeed`'s liquidation
events on our corps ONLY (filtered by `address: <our_corps>`, never market-wide).
When ≥2 distinct corps liquidate within a 5-min rolling window, force-pauses all
corps for 30 min. Tunable via `/bot breaker config <window_min> <threshold>
<cooldown_min>`. Independent from danger-score panic — fires on observed losses,
not predicted ones. **Critical**: uses event TIMESTAMP (block-derived, not
Date.now) so backfilled events on restart can't spuriously trip the breaker.

**Built-in presets** (Extortion deliberately excluded):
| Name | Modes (per corp) | Use case |
|---|---|---|
| `all-arms` | [Arms, Arms, Arms] | Calm markets — 3× cycles/hr |
| `all-drug` | [Drug, Drug, Drug] | Active markets — 0.518% threshold absorbs |
| `mix-arms` | [Arms, Arms, Drug] | Hedged calm |
| `mix-drug` | [Drug, Drug, Arms] | Hedged active |
| `paused` | (auto-trade disabled) | Dead zones — saves INF |
| `panic` | (auto-trade disabled) | Danger override target |

**Default HKT schedule** (v2 — May 8 2026, evidence-derived):
```
00h     →  all-drug  (Drug d̄=52, sr=38% — marginal but net-positive vs idle)
01-02h  →  all-drug  (Drug d̄=58-95 across the band; Arms d̄=43-76)
03h     →  all-arms  ⭐ v2 EDIT: Drug 87.8 liqs/day at 03h (33% of all liqs); Arms 9.5/day → switched
04-08h  →  all-drug
09h     →  all-arms  (Arms d̄=53 vs Drug d̄=52 — slight Arms edge)
10-13h  →  all-drug  (Drug d̄=82-91 — calm Asia midday)
14h     →  all-arms  (Arms d̄=81 vs Drug d̄=79 — only hour Arms cleanly wins)
15-16h  →  all-drug  (Drug d̄=75-93)
17h     →  all-arms  ⭐ v2 EDIT: Drug 29 liqs/day vs Arms 8.5 — Arms safer
18h     →  all-arms  ⭐ v2 EDIT: Drug 46.7 liqs/day vs Arms 15.7 — Arms safer
19h     →  all-drug  (Drug d̄=93 — peak; 0 Drug liqs in 7-day evidence)
20h     →  all-drug  (Drug d̄=74, sr=52%)
21-22h  →  paused    (21h sr=10%, 22h sr=14% — confirmed by v2 evidence)
23h     →  all-drug  (Drug d̄=65, sr=30%)
```
Three v2 changes (03h, 17h, 18h) all flip from all-drug to all-arms based on the
schedule-evidence feed's first 7-day rolling sample (31,849 ops scanned 2026-05-08).
If the next 5–7 days don't bear them out, revert by flipping the slot back.
**Lens choice matters**: above is yield-per-op (each op costs 5 INF; INF is the scarce resource). Drug wins almost every hour because its 0.518% liq threshold beats Arms's 0.176%. If/when INF stops being the binding constraint (PL3 or massive USDM reserves), switch lens to DIRTY-per-hour and Arms wins almost every hour (3× cycle speed). Re-analyze quarterly — meta drifts as network composition changes.

**Telegram admin GUI** (operator-only via `TG_OPERATOR_CHAT_ID`):
- `/menu` or `/bot` (with no args) — opens inline-keyboard GUI with buttons:
  - 📊 Full Status · 💰 Wallet · 🎯 Presets · 📅 Schedule · 🔌 Breaker · ⚙️ Config
  - 💸 Claim Now · ⏸ Pause / ▶️ Resume · 📋 Recent Logs · 🔄 Refresh
- All actions navigate via `editMessageText` so the menu doesn't spam new messages
- Operator-auth check on every callback_query
- Text commands below still work as escape hatch:

**Text commands** (operator-only):
- `/bot help` — full subcommand list (text mode)
- `/bot preset list` / `/bot preset <name>` / `/bot preset auto`
- `/bot schedule` / `/bot schedule on|off` / `/bot schedule <range> <preset>`
- `/bot custom <m1> <m2> <m3>` — quick custom (only Arms/Drug)
- `/bot drug` / `/bot arms` — force uniform mode (no Ext)
- `/bot claim` — force claim all corps now
- `/bot pause` / `/bot resume` — operator-level pause
- `/bot thresholds <high> <low>` — danger band (default 65/45)
- `/bot panic <threshold>` — danger override threshold (default 75)
- `/bot logs` — last 20 in-memory log lines
- `/bot breaker` / `/bot breaker clear` / `/bot breaker config W T C` — circuit breaker

### Security audit status (passed by Codex CLI)
- ✅ MAIN_KEY format-validated before ethers; init errors don't leak the key
- ✅ Tick reentrancy guard + NonceManager (no duplicate txs)
- ✅ Async shutdown waits up to 30s for in-flight tx
- ✅ DM cooldown buckets (per corp + kind, 60s default)
- ✅ Strict integer regex on `TG_OPERATOR_CHAT_ID`
- ✅ `npm audit` reports 0 vulnerabilities (fastify, @fastify/static, brace-expansion all updated)
- ✅ Bot can ONLY call `enableAutoTrade(uint8)`, `disableAutoTrade()`, `claimRewards()` on hardcoded corp addresses

---

## 🏗 Operator state (UPDATE on every relevant turn)

> **VERIFY BEFORE QUOTING**: pull `http://localhost:3456/api/state` or query
> chain directly. Don't trust this section if it's older than the conversation.

### Wallet: `0x30C620cf1fbC38083FfE2c645Fb45d7FE487e194`
- Latest snapshot: see `/bot` or dashboard

### Game progression (last known — May 7 2026 evening)
- **Power Level**: 2 ✅ (unlocked May 7 for $65 USDM — matches docs)
- **DIRTY per op**: 115 at PL2 (was 100 at PL1, becomes 130 at PL3)
- **Legitimacy / Status**: 3 ✅ (XP ~1,265/3,900 → Status 4 needs ~2,635 more XP + 1,500 DIRTY)
  - Confirmed via `getUserProfile` on generatorManager
  - Status 3 unlocked: +13 base sus tolerance (73→86), +2pp cleaning bonus (1%→3%), drop rates 65/24/9/2 → 58/26/13/3
- **Active corps**: 6 (3 Caribbean L1 + 3 L2 Europe: Malta/Cyprus/Andorra) — all bot-managed
- **L3 corps**: 3 pre-deployed but locked behind PL3 (3,600 XP + $250 unlock + 3×$75 corp fees ≈ $475 total)
- **Loadouts (Enterprises)**: 2 active (E1 + E2 unlocked Day 2). Loadout 3 still locked despite PL2 — likely day-gated.
- **Inventory**: ~16-19 items (varies as user buys/sells packs)
- **Notable assets**: 3 Legendaries (IRS Mogging in Method, Memecoin Washtrading in Method, Trump in Associates) + 1 Epic (Shell Company Expert) + a few Rares (Crypto Exchange, Casino, ETH Foundation, Encrypted Comms, Data Haven)
- **🚨 Mystery**: `balanceOf(presaleSbt, operator) = 0` despite operator buying Kingpin bundle ($490). Worth investigating — either the SBT lives in a different wallet, or the contract address is wrong, or claim flow not yet completed.

### Enterprise inventory (14/20 owned)
**Equipped in Loadout 1:**
| Slot | Asset | Rarity | Effective stats |
|---|---|---|---|
| Business | Crypto Exchange | 🔵 Rare 1.5× | 13.5 CR, 18% Eff |
| Insurance | SBF's Parents | ⚪ Common | 6 CR, 6 ST, 5% Eff, 2% Disc |
| Associates | ETH Foundation | 🔵 Rare 1.5× | 18% Eff, 10.5% BC |
| Method | **IRS Mogging** | 🥇 **Legendary 4.5×** | **36 CR, 18% Disc** |
| Accountant | Caroline's Spreadsheet Guy | ⚪ Common | 6 CR, 4 ST, 5% Eff, 5% Disc |
| OpSec | Secure Vault | ⚪ Common | 14 ST |

**Unequipped (8 known):** Trump, Wintermute, Peptide Synthesis Company,
Celsius Withdrawal Pause, Political Protection, Luna-UST Depeg Arbitrage,
Tornado Mixer, Memecoin (Launchpad?), Loan Schemes, Encrypted Comms,
Data Haven, Montenegro Safehouse — all Common.

**Loadout 1 stats** (last shown):
- Cleaning Rate: 110, Reputation: 98, Eff: 147%, BC: 10.5%, BM: 110%, Disc: 28%
- Survival: 33%, Est. cycle output: 54.84M
- **Bottleneck: SURVIVAL.** Discretion has 42pp of headroom (cap 70%)

### On-chain contracts (MegaETH) — full registry from frontend JS bundle
| Contract | Address | What it does |
|---|---|---|
| DIRTY (ERC-20) | `0xc2f34f8849a8607fd73e06d6849bda07c2b7de38` | Main reward token |
| INF (ERC-20) | `0x403de0893f0bc66139592ba2fd254672f2db933a` | Operation fuel |
| USDM (ERC-20) | `0xfafddbb3fc7688494971a79cc65dca3ef82079e7` | Stablecoin reward |
| OSBT (ERC-721) | `0x943b75c86b83b8125d8e2b56d15fd30e8e1a0e74` | Presale SBT |
| User Factory | `0x619814a203ca441611cee02abf31986ca265dd35` | `getUserCompanies(addr)` returns 9 corp slots |
| Game proxy | `0xcd8e5aaee73730347d8a3568d57510158a07b4a6` | configRegistry (impl `0xfaf58db2...`) |
| Corp beacon | `0x9fd0f6bb79547c8a2d4f3a625a8de6abfcc5f55b` | impl `0xf483b1c4...` |
| **Generator Manager** | `0x1b5AB7c503C2B1D94e7C42b212b4F944F7c77fce` | **Enterprise/loadout state** — `getUserGenerators`, `getEquippedItems(genId)→uint256[6]`, `getInventory(addr)`, `getItem(itemId)→(templateId, rarity, owner)`, `getTemplate(tid)→(itemType, cr, hp, eff, bc, bm, disc)`, `getAggregateStats(genId)`, `getUserProfile(addr)→(level, xp)` |
| Gacha | `0x1bf6ef01ADDb0181634370314aC6ee843d4A1c5E` | Asset purchases — `commit(uint256)` (200 DIRTY burn), `reveal()`, `canReveal(addr)`. Commit-reveal RNG to prevent miner-frontrunning. |
| Swiss Vault | `0x955a4adDc17114C36726c12af9c73E23E497c2bD` | Auto-laundering 8h cycles. Not yet wired into bot. |
| Cycle Rewards | `0x8C73Cd3BB0bFB577D4578bB075640C1eCc5027c8` | USDm claim contract. `currentCycleId`, `getCycle`, `hasClaimed`, `pendingRewardPool`. |
| Trade Router | `0xF9f676066eB7BaEEED93E859BC26a41663F277A8` | Routes trade execution |
| Account Manager | `0xB0f8243e20a531b0A32bd5270A34eA18c7C4b68e` | Per-user state (cooldowns, claims) |
| Faction Staking | `0x3620bbEDED3BcF1b3409098Dc152b0EEcf66eA8e` | Faction system (not in docs yet) |
| QuoterV2 (Uniswap V3) | `0x1F1a8dC7E138C34b503Ca080962aC10B75384a27` | DIRTY/USDM AMM quotes |
| Multicall3 | `0xca11bde05977b3631167028862be2a173976ca11` | Batch RPC reads |

### Active corp addresses
| Index | Address | Region | Bot-managed |
|---|---|---|---|
| 0 | `0x60290db367cb46f3b0c1b439dbc0fed86aa24f90` | L1 Caribbean (Cayman) | ✅ |
| 1 | `0x2d6fb5a377d0a6d463c3aea17973609659afd0f0` | L1 Caribbean (BVI) | ✅ |
| 2 | `0x5f1b5afbbf9bed706d1806326479ddd36c8eec4a` | L1 Caribbean (Bermuda) | ✅ |
| 3 | `0x103469af1609c2341ae313e6fbfaab56022faa1a` | L2 region | ✅ (added May 7) |
| 4 | `0x35ebd95455aae47b66b4baf10654c34898aefa67` | L2 region | ✅ (added May 7) |
| 5 | `0x67aee1ca6e9b37ccfcbb9d62efd8a6a3f32db49f` | L2 region | ✅ (added May 7) |
| 6 | `0xf3bbfb854d57abf0cdda5b2a5219f5e2ca026c85` | L3 region | ⛔ locked, PL3 |
| 7 | `0xd9552288607fec4c113372f38f78347a050b60de` | L3 region | ⛔ locked, PL3 |
| 8 | `0x1e99791a6bd597ff892e0c6ae405b440aa582c7c` | L3 region | ⛔ locked, PL3 |

Bot's `mix-arms` preset for 6 corps now spreads as `[Arms,Arms,Arms,Arms,Drug,Drug]` (4:2 ratio
matching the 2:1 ratio operator originally specified for 3 corps). Same for `mix-drug` flipped.

### Corp contract write functions (Ownable, no delegate role)
- `enableAutoTrade(uint8 mode)` — `0xd3d5dc49` — sets the auto flag + mode
- `disableAutoTrade()` — `0xa1cbb822`
- `startTrade(uint8 mode)` — `0x90446253` — bootstraps the FIRST trade. Required for newly-activated corps; auto-restart only fires AFTER an initial trade exists.
- `completeTrade()` — `0x234d442b` — finalizes a finished trade. Without this call, finished trades sit in limbo and the contract will NOT auto-start the next op even with auto-trade enabled.
- `claimRewards()` — `0x372500ab` — transfers pending DIRTY to the owner.
- `liquidate()` — called by oracle, not us.

**Bot tick logic (since the startTrade/completeTrade fix):**
1. Read state (autoEnabled, mode, isActive, isCompletable, cooldownEnd) in one Promise.all
2. If `hasPendingClaim` → `claimRewards()`
3. If `isCompletable` → `completeTrade()` (triggers auto-restart)
4. If paused preset → `disableAutoTrade()` if currently on
5. If `!autoEnabled` → `enableAutoTrade(targetMode)` (set flag)
6. If `autoEnabled && !isActive && cooldownPassed` → `startTrade(targetMode)` (bootstrap)
7. If mode mismatch → `enableAutoTrade(targetMode)` (mode change)

---

## 📊 Dashboard upgrade roadmap

Things the dashboard could surface to help good decisions. Built items checked.

### TIER A — high value, easy wins
- [ ] **Swiss Vault cycle countdown** — operator declined (in-game UI is sufficient). Could add cycle-close TG alerts later.
- [ ] **Status XP progress bar** — XP toward next Status (current: 1,040/1,950 → S3) with DIRTY cost preview (800)
- [ ] **Power Level XP progress bar** — current: 644.8/700 → PL2
- [x] **INF runway projection** — DONE. 5th cell in WALLET card, shows hours+ETA to 25 floor, color-coded (red <4h, green if growing, ∞ if not burning)
- [x] **DIRTY price chart** — DONE. New magenta card pulls Kumbaya history (`https://kumbaaya.exchange/exchange/tokens/<addr>/history?chainId=4326`) + live spot price every 5min. Daily candles + launch-price reference line + 24h change + TVL/vol footer.
- [x] **Loadout panels** — DONE. 3 cards: MY ENTERPRISES (your full loadouts, rarity-colored), ASSET META (top equipped network-wide with rarity-stacked bars), WHALE WATCH (top 10 players, collapsible rows: compact view shows balances/corps/ops summary, click to expand for full loadouts + per-corp op state with active/cooldown/pending/INF-staked). Backend: `LoadoutScannerFeed` reads `generatorManager` (`0x1b5AB7c5...`) — `getUserGenerators`, `getEquippedItems`, `getItem`, `getTemplate`, `getInventory`, `getAggregateStats`. Network-wide ranking from TradeCompleted/TradeLiquidated logs. PM2 mem cap raised to 768M.
- [x] **5-tab dashboard** — DONE. Top-of-page tab nav routes cards into: ⚡ OPS (corps, op log, activity, suggestion, op cards), 📈 MARKET (ETH, danger, vol, CVD, orderbook, liquidations, heatmap, hyperliquid, suggestion, op cards), 💰 WALLET (wallet+runway, DIRTY price), 🏢 ENTERPRISE (my loadouts, asset meta, whale watch), 🌐 NETWORK (tokenomics, asset meta, whale watch, DIRTY price). Wallet card visible on both Wallet and Ops. Persisted via `localStorage['offshore-active-tab']`. CSS-only show/hide via `body[data-active-tab]` selectors.
- [x] **Loadout simulator (Python)** — DONE. Uses exact in-game formula extracted from JS bundle: totalTicks=900, cycleBaseDamage=3333, cycleOutputHeatCoeff=20, cycleDiscretionCap=7000 (70%), cycleDamageScale=10000. Brute-forces (E1, E2) splits respecting "1 of each category, no asset reused" constraint. Found +200% combined output gain by concentrating Legendaries into a "mega loadout". Lives at `/tmp/optimize2.py` for now — should be productionized into the dashboard or TG menu.
- [ ] **Per-op real-time EV** — given current danger + thresholds, expected DIRTY/op/hour for Arms vs Drug
- [ ] **Schedule visualization** — 24h ring showing current preset, next transitions

### TIER B — medium value
- [ ] **Loadout simulator** — drag-drop equipped/unequipped, show predicted survival/output
- [ ] **Asset inventory tracker** — full list with rarities (currently we only know what user told us; should pull on-chain)
- [ ] **Cycle output history** — past cycles' DIRTY earned, USDM claimed, vault share %
- [ ] **Decision recommender** — given state, suggest next action (claim now / switch mode / buy assets / level up Status)
- [ ] **Network leaderboard** — your share of network cleaning, rank
- [ ] **Vault projected payout** — "if cycle ended now, you'd claim $X USDm"

### TIER C — automation / off-chain
- [ ] **@OffshoreOnMega Twitter monitor** — scrape for unlock announcements, season events
- [ ] **Discord channel watch** — for surprise game changes
- [ ] ~~Auto-claim USDM at cycle close~~ — operator declined for now (manual)
- [ ] ~~Auto-reinvest USDm → INF~~ — operator declined for now (manual)
- [ ] **Auto-spend DIRTY on assets** — when at Status 3, after Loadout 2 unlocks, etc.

### TIER D — research / experimental
- [ ] **Backtest preset performance** — replay history with different schedules, see which actually wins
- [ ] **Volatility regime forecaster** — predict next dangerous window from ETH options IV
- [ ] **Multi-loadout solver** — when L2/L3 unlock, optimize asset distribution across all loadouts

**When picking what to build next**: the reinvestment loop is the highest-EV thing
per the docs. Auto-claim USDm + auto-buy INF closes the flywheel and matches the
"dominant strategy."

---

## 🛠 Operations playbook

### Restart the bot
```bash
cd /home/muffinman/Offshoreprotocol
npm run build && pm2 restart offshore-terminal --update-env
```

### Tail bot logs
```bash
pm2 logs offshore-terminal | grep CorpBot
```

### Check current op stats
```bash
node -e "
const Database = require('/home/muffinman/Offshoreprotocol/node_modules/better-sqlite3');
const db = new Database('/home/muffinman/Offshoreprotocol/data/offshore.db', { readonly: true });
console.log(db.prepare('SELECT op_type, COUNT(*) n, AVG(dirty_earned) avg FROM op_outcomes GROUP BY op_type').all());
"
```

### Pull live state
```bash
curl -s http://localhost:3456/api/state | python3 -m json.tool | head -50
```

### Run the security audit again
```bash
codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox < /tmp/audit-prompt.md
```

---

## 🔄 Maintenance

When the operator's portfolio or the game changes meaningfully, **update this
file**. Specific triggers:
- Power Level changes → update progression table
- Status changes → update progression + recompute Status 3 affordability
- New corp deployed (PL2/PL3 unlock) → add to active corps table; tell user
  to call me to wire it into CorpBot's corp list
- New asset acquired → re-evaluate loadout
- Loadout 2/3/4 unlocks → tell the user, build allocator if they want help
- llms.txt content changes → re-fetch and reconcile this file's sections

If `WebFetch https://www.offshoreprotocol.fun/llms.txt` returns content that
disagrees with this file, **trust llms.txt and update CLAUDE.md**.

---

## 🔒 FlowDirty.fun privacy contract

The public surface (`flowdirty.fun`) makes specific privacy claims to visitors
in the wallet-tracker UI. They MUST stay true. The contract:

- **Read-only.** No write paths reachable from any public route. No
  wallet-connect, no signature flow.
- **Wallet addresses never persisted to disk.** Verified by:
  - `disableRequestLogging: true` on the Fastify instance + a redacting
    `serializers.req` that rewrites `/api/track/0x…` → `/api/track/[redacted]`
  - `walletLogTag()` in `src/utils/wallet-log.ts` is used everywhere a
    wallet would otherwise appear in a log line (`wallet-tracker.ts`,
    `loadout-scanner.ts`, `server.ts`)
  - nginx `access_log off; error_log /dev/null crit;` on `/api/track/`
    and `/api/track-stats`
  - rate-limiter stores `walletTags: Set<string>` (sha256 prefixes), never
    raw wallet/IP joins
- **Cleared from memory after 30s.** `WalletTracker.cache` schedules an
  `unref'd setTimeout` at TTL that deletes the entry; `size()` and `peek()`
  also prune lazily.

### Why we DON'T denylist the operator's wallet

The first audit suggested rejecting `config.walletAddress` on `/api/track/:wallet`
to prevent the public tracker from exposing the operator's position.
**Decision: not implementing.** Reasoning:
1. The data is public on-chain — anyone can pull it via Etherscan or any
   MegaETH RPC explorer. Blocking it on FlowDirty doesn't add privacy.
2. A denylist creates an **ownership tell** — the one address that 404s
   confirms operator ownership when probed. Denying nothing is more
   anonymous than denying just the operator.
3. The operator wants to use their own tracker.

If the operator ever wants to break this and add a denylist, do it in
`src/api/server.ts` inside the `/api/track/:wallet` handler before
calling `walletTracker.track(wallet)`, AND make sure the 404 response
shape is identical to the "Bad Request" 400 to avoid the timing/shape
tell.

### Audit trail

- Initial audit: `/tmp/flowdirty-audit-result.md` (5 critical, 2 high)
- Post-fix verification: `/tmp/flowdirty-verify-result.md` (8/9 PASS, 1 partial — the partial was the unrelated CorpBot startup log, since redacted)
- Re-run with: `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox < /tmp/flowdirty-verify-prompt.md`

---

## 📜 Conversation context lessons

Things learned the hard way that should NOT be repeated:

1. **Don't paste private keys in the chat.** Both Telegram bot tokens and
   private keys leaked via this chat at various points. ALWAYS instruct the
   operator to put secrets directly into `.env` on the server via SSH.
2. **Don't read MetaMask asset borders as rarity colors blindly.** Operator's
   correction: only specific assets are non-Common (Crypto Exchange Rare,
   IRS Mogging Legendary, ETH Foundation Rare). Always ask if uncertain.
3. **The dash before "Est. Cycle Output" is a separator, NOT a negative.**
   The operator corrected me twice. Output is positive.
4. **Corp ownership cannot be transferred.** The corps are Ownable but the
   game contracts won't actually accept the new owner. Use main wallet key.
5. **Extortion is OFF-LIMITS.** 0.039% threshold. Operator policy.
6. **The operator is in Hong Kong (HKT, UTC+8)**. All schedules are HKT-aware.
7. **Verify on-chain state before answering "do you have X"**. Don't guess.
8. **The opening week pool is >$100K USDm**. Time-pressure decisions matter
   more now than they will later.
9. **`enableAutoTrade` alone does NOT start the first trade.** Newly-activated
   corps require an explicit `startTrade(mode)` call to bootstrap. Auto-restart
   only fires AFTER an initial trade has run. Same for resumed corps after
   long idle: if `cooldownEnd <= now && !isActive && autoOn`, call `startTrade`.
10. **`completeTrade()` must be called to finalize finished trades.** Without
    it, finished trades sit in limbo and the contract never auto-restarts the
    next op even with auto-trade enabled. Bot now calls it whenever
    `isCompletable` returns true.
11. **Don't use ethers `NonceManager` for serialized writes.** It can desync
    from the network and produce `NONCE_EXPIRED` errors. Since the tick
    reentrancy guard already serializes writes (await tx.wait between each),
    using the raw wallet is simpler and reliable. The bot fetches the next
    nonce from RPC for each tx instead of caching.
12. **The optimizer's brute-force can give bad advice if inventory is stale.**
    The simulator FORMULA matches in-game UI to ±0.01% (validated). But the
    optimizer's *recommended swap* depends on what items it sees in inventory
    at scan time. Operator caught a regression where keeping Memecoin
    Washtrading Legendary in E1 *beat* the optimizer's suggested Luna-UST
    Epic swap, because we had different items than the optimizer assumed.
    **Always sanity-check by comparing predicted vs actual in-game numbers
    before recommending a swap.** Simulator constants:
    `totalTicks=900, cycleBaseDamage=3333, cycleOutputHeatCoeff=20,
    cycleDiscretionCap=7000 (70%), cycleDamageScale=10000`. Simulator
    lives at `/tmp/optimize2.py` — productionize when ready.
13. **The "Starter Business" (template 44, CR=1) is NOT a presale perk.**
    It's the most-equipped Business asset network-wide because half the field
    pulls it from a normal pack and never replaces it. Our user does NOT have
    one. Mystery: their wallet shows 0 presale SBT despite buying Kingpin.
14. **Whales run all-Extortion at scale, NOT because Ext is +EV per-op, but
    because failed INF funds the Vault pool that their mega-loadouts capture
    pro-rata.** At our user's 0.3% pool share, Ext loses ~$280/cycle directly.
    To break even on Ext, they'd need ~0.93% pool share (3× larger Enterprise).
    PL3 unlock ($475) reduces breakeven to 0.30% — exactly the user's current
    share. So PL3 unlocks the whale strategy. Until then, Drug/Arms is correct.
15. **Op-scraper backfill timestamps were a circuit-breaker bug.** When the bot
    restarts, OpScraperFeed replays missed events with `Date.now()` as ts,
    making the breaker think 5 corps liquidated in the same minute. FIXED:
    scraper now derives event ts from block-number delta (MegaETH = 1s/block),
    and breaker drops events older than its window before counting.
16. **Loadout-scanner's network meta needs ~310MB RSS.** Original PM2 mem cap
    was 256M which caused 49 restarts in a few minutes. Bumped to 768M.
17. **MegaETH RPC payload limits.** Multicall3 batches above ~150 calls return
    "413 Payload Too Large". Keep batch sizes ≤120 for getItem-style calls,
    ≤150 for lighter calls.

---

## 🛠 What's pending / on the build queue

(Not yet built, ranked by ROI for the operator)

1. **Productionize the loadout simulator** as a dashboard panel — interactive
   "swap simulator" where the operator picks 2 items to swap and sees
   predicted output delta BEFORE committing on-chain. Path:
   `/tmp/optimize2.py` → in-process module → API endpoint → React panel.
2. **Per-op real-time EV widget** on OPS tab — given current danger score,
   show "Drug X DIRTY/op, Arms Y DIRTY/op" updated every second.
3. **Status / Power Level XP progress bars** — small widget showing distance
   to next milestone with DIRTY cost preview. ~1h.
4. **Vault claim history tracker** — pull each whale's USDm claims from
   `cycleRewards` contract to empirically confirm the pool-capture theory.
5. **Whale-state time-series tracking (Tier 3)** — snapshot top 10 every
   15 min, surface "swap detected" alerts via TG. SQLite already exists.
6. **Investigate the missing presale SBT** — operator bought Kingpin but
   `balanceOf(presaleSbt, operator) = 0`. Either wrong contract or unclaimed.

---

## 🐛 Known issues / observations to verify

- After 23:00 HKT (when the schedule exits the paused window), all 6 corps
  should be running ops. If any stay idle, the startTrade bootstrap may have
  more edge cases to handle. Check `/bot status` and chain state.
- Latest op-scraper-cursor.json may have stale block reference — bot startups
  re-scan from cursor and could overwhelm RPC. Watch logs for batch failures
  on first ticks.
- The Whale Watch tier-3 (time-series) work needs a SQLite migration to add
  a `whale_snapshots` table (not yet created).
