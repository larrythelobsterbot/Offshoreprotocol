# GMX V2 on MegaETH — Contract Research

> **Status**: research-only deliverable per the GMX Hedge Adaptation
> brief. **Do not adapt `hedge-bot.ts` against this until the operator
> reviews the POC results below and approves the trade flow.**
>
> Researched 2026-05-12 from a mix of: GMX official docs
> (`docs.gmx.io/docs/api/contracts/addresses/`), the GMX governance
> proposal for MegaETH, and direct chain queries against MegaETH
> mainnet. All addresses verified on-chain (non-zero bytecode).

---

## TL;DR

- **Real GMX V2** on MegaETH — not a fork. Mainnet live since 2026-04-30.
- **Markets**: BTC/USD, ETH/USD, SOL/USD, MEGA/USD (USDm-collateralized).
- **Max leverage 50x**, not 85x. Operator's screenshot likely showed a
  global UI maximum applied across all markets / chains; ETH on MegaETH
  is capped at 50x. The operator's target 20-25x is still well inside.
- **Oracle**: sequencer-level Chainlink Data Streams integration.
  Low-latency (<1s typical). Divergence vs RedStone is unknown but
  likely smaller than the HL-perp-→-RedStone divergence we've seen
  (max 3.86bps so far).
- **Execution**: keeper-based. Order is submitted, keeper picks it up
  and executes with a price signed at the order's block (~hundreds of
  ms on MegaETH per GMX's announcement; ~1-5s typical on Arbitrum).
- **Trade flow**: NOT single-tx. Three-step multicall pattern:
  `sendWnt(executionFee)` + `sendTokens(USDM)` + `createOrder(...)`.
  TP/SL are a SEPARATE order (`LimitDecrease`).

---

## Contract Addresses (MegaETH chain ID 4326)

All verified on-chain via `eth_getCode` against
`https://mainnet.megaeth.com/rpc`:

| Contract        | Address                                       | Bytecode  |
|-----------------|-----------------------------------------------|-----------|
| ExchangeRouter  | `0x73B3593F01CF8e573a412D1d0c972b581794ebE0`  | 48916 B   |
| Router          | `0x1eAfB14236C489C28845EC04F78DECA5Fb9879Aa`  | 3054 B    |
| Reader          | `0x0f038EB4a38B08cd3c937a3256b51aa01904a684`  | 47976 B   |
| DataStore       | `0xE43C7B694f6b652a9F4A0f275C008d18758Dce35`  | 20824 B   |
| OrderVault      | `0xD5AE04762E2afb1506695b3F36286EBE7B0E6772`  | 9136 B    |
| OrderHandler    | `0x7d5F99Bab016b831648e278B208579e0eCdb3974`  | 46250 B   |
| RoleStore       | `0xecA46636BDDbb4F451ca2B7062C7E36744934655`  | 4578 B    |
| EventEmitter    | `0xAf2E131d483cedE068e21a9228aD91E623a989C2`  | 15630 B   |

**Source**: `https://docs.gmx.io/docs/api/contracts/addresses/`.
(The `gmx-synthetics` GitHub repo's `docs/` folder has machine-readable
deployment files for arbitrum / avalanche / botanix but NOT yet for
megaeth — the addresses above come from the rendered docs page.)

### Markets (queried via `Reader.getMarkets(DataStore, 0, 50)`)

```
#0  marketToken=0xBc7e..c8a7   index=WETH long=WETH short=WETH       — ETH GLV vault (pure ETH pool)
#1  marketToken=0x31Ed..3D59   index=0xc258..(WBTC?) long=USDm short=USDm
#2  marketToken=0x9b1B..48b1   index=WETH  long=USDm short=USDm     ← ETH/USD PERP MARKET (THE ONE WE WANT)
#3  marketToken=0xe8E7..fEe9   index=0x3099..(SOL?)  long=USDm short=USDm
#4  marketToken=0xc5c9..5e2e   index=0x0   long=WETH short=USDm     — USDm-WETH GLV vault
#5  marketToken=0x1b99..0e5f   index=MEGA  long=USDm short=USDm     — MEGA/USD perp
```

**ETH/USDm perp market**: `0x9b1B72720f6D277F3b1e607a0c5fab1B300248b1`

- `indexToken` = WETH (`0x42000000...`) — price reference, not held.
- `longToken` = USDm — collateral when going long ETH.
- `shortToken` = USDm — collateral when going short ETH.

For a short-ETH hedge, both `long/short` collateral is USDm, so we use
USDm as `initialCollateralToken`. Same as the operator's screenshot
("USDM-USDM pool, collateral USDM").

### USDm token

`0xfafddbb3fc7688494971a79cc65dca3ef82079e7` — same address as in
`CLAUDE.md` and the rest of the project. No new approval pattern; we
already hold USDm in `MAIN_KEY` from claim cycles.

---

## Trade Flow (createOrder)

### Pre-step: approve USDm spend (one-time per amount)

```ts
const usdm = new ethers.Contract(USDM, ERC20_ABI, wallet);
// Approve Router (not ExchangeRouter — the Router has the pluginTransfer
// privilege that lets OrderVault pull tokens during sendTokens())
await usdm.approve(ROUTER, ethers.MaxUint256);
```

### Order: ExchangeRouter multicall

`ExchangeRouter` inherits `BaseRouter` which provides `sendWnt`,
`sendTokens`, `sendNativeToken`. The standard V2 pattern is one multicall:

```ts
const calls: string[] = [
  // 1) Send native MEGA (will be wrapped to WMEGA inside) for the
  //    keeper execution fee. Amount is per-order; recommended floor ~
  //    0.0005 MEGA on Arbitrum-class chains. Verify on MegaETH via
  //    DataStore lookup (see "Execution fee" below).
  exchangeRouter.interface.encodeFunctionData('sendWnt', [ORDER_VAULT, executionFee]),

  // 2) Send USDm collateral to OrderVault. Uses Router.pluginTransfer
  //    under the hood — requires the prior approve() above.
  exchangeRouter.interface.encodeFunctionData('sendTokens', [USDM, ORDER_VAULT, marginAmount]),

  // 3) Create the order against the funded vault.
  exchangeRouter.interface.encodeFunctionData('createOrder', [params]),
];

const tx = await exchangeRouter.multicall(calls, { value: executionFee });
```

### `CreateOrderParams` struct (from `IBaseOrderUtils.sol`)

```solidity
struct CreateOrderParams {
  CreateOrderParamsAddresses addresses;        // see below
  CreateOrderParamsNumbers   numbers;          // see below
  Order.OrderType            orderType;        // enum, see below
  Order.DecreasePositionSwapType decreasePositionSwapType;
  bool   isLong;                               // false for short
  bool   shouldUnwrapNativeToken;              // false; keep WETH wrapped
  bool   autoCancel;                           // see below
  bytes32 referralCode;                        // 0x0..0 unless we have a code
  bytes32[] dataList;                          // empty
}

struct CreateOrderParamsAddresses {
  address receiver;                  // our MAIN_KEY
  address cancellationReceiver;      // our MAIN_KEY
  address callbackContract;          // 0x0..0 (no callback)
  address uiFeeReceiver;             // 0x0..0 (no UI fee)
  address market;                    // 0x9b1B..48b1 (ETH/USDm perp)
  address initialCollateralToken;    // USDm
  address[] swapPath;                // empty []
}

struct CreateOrderParamsNumbers {
  uint256 sizeDeltaUsd;              // POSITION USD * 1e30
  uint256 initialCollateralDeltaAmount;  // MARGIN in USDm wei (18 dec)
  uint256 triggerPrice;              // 0 for market, else USD/1e_priceDecimals
  uint256 acceptablePrice;           // worst price we'll take, for slippage
  uint256 executionFee;              // matches the WMEGA we sent in step 1
  uint256 callbackGasLimit;          // 0
  uint256 minOutputAmount;           // 0 (we set acceptablePrice instead)
  uint256 validFromTime;             // 0 = valid immediately
}
```

### `Order.OrderType` enum values (from `Order.sol`)

```
0  MarketSwap
1  LimitSwap
2  MarketIncrease     ← OPEN short  (use this on hedge open)
3  LimitIncrease
4  MarketDecrease     ← CLOSE short (use this on hedge close)
5  LimitDecrease      ← TP order    (use this for the protective TP)
6  StopLossDecrease
7  Liquidation
8  StopIncrease
```

### TP order details

A TP is a SECOND order created with `OrderType.LimitDecrease`:
- `triggerPrice` = the price at which to close (for a short, the TP is
  BELOW entry — we want price to fall to profit)
- `sizeDeltaUsd` = full position size to close completely
- `initialCollateralDeltaAmount` = 0 (closing doesn't add collateral)
- `acceptablePrice` = some slippage tolerance worse than triggerPrice
- `autoCancel` = TRUE — if the position is closed by another order
  (e.g. our `MarketDecrease`), the TP cancels itself

### Price encoding

GMX V2 prices are encoded as `USD_PER_UNIT * 10^(30 - tokenDecimals)`.
For WETH (18 decimals), price 1 ETH = $2261 encodes as:

```
2261 × 10^(30 - 18) = 2261e12 = 2_261_000_000_000_000
```

For BTC (8 decimals) it would be `BTC_PRICE × 10^22`. WBTC on MegaETH
needs verification.

`sizeDeltaUsd` is plain USD × 1e30:
```
$100 = 100 × 10^30 = 1e32
$25000 = 25000 × 10^30 = 2.5e34
```

This is the field most likely to be encoded wrong. Triple-check.

### Execution fee

Native MEGA sent per order to reimburse the keeper. The minimum is
gas-price-dependent and bounded by DataStore keys. Standard pattern:

```ts
import { hashData } from './gmx-utils';

const ORDER_GAS_KEY = hashData(['string', 'uint256'], ['INCREASE_ORDER_GAS_LIMIT', 0]);
const orderGasLimit = await dataStore.getUint(ORDER_GAS_KEY);
const gasPrice = (await provider.getFeeData()).gasPrice;
const executionFee = (orderGasLimit + 1_000_000) * gasPrice;  // 1M gas overhead buffer
```

In practice ~0.0001-0.001 MEGA per order on Arbitrum-class chains. On
MegaETH with $0.05 typical network fees, executionFee should be under
$0.10 per order. We pay this twice per hedge (open MarketIncrease + TP
LimitDecrease) and once more on close.

---

## Reading position state

Use `Reader.getPosition(dataStore, positionKey)`. The positionKey is:

```ts
const positionKey = ethers.solidityPackedKeccak256(
  ['address', 'address', 'address', 'bool'],
  [account, market, collateralToken, isLong],
);
```

So for our short, collateralToken=USDm and isLong=false:

```ts
const positionKey = ethers.solidityPackedKeccak256(
  ['address', 'address', 'address', 'bool'],
  [wallet.address, ETH_MARKET, USDM, false],
);
const pos = await reader.getPosition(DATA_STORE, positionKey);
// pos.numbers.sizeInUsd, pos.numbers.collateralAmount, etc.
```

`getMarketTokenPrice()` on Reader also returns the latest GMX-side oracle
price (the one used at execution). Useful for our oracle-divergence log.

---

## Fees (verified against the operator's screenshot)

- **Trading fee**: ~0.054% × position size, paid once at open, once at
  close. For a $25,000 hedge: $13.50 open + $13.50 close = **$27 round-trip**.
- **Network fee**: ~$0.05 per tx. Three txs per hedge (open + TP + close)
  ≈ $0.15.
- **Price impact**: capped at 0.5% (50 bps) per GMX's announcement.
- **Funding rate**: variable, charged on open positions. Drug ops last
  90 min so funding accrual is small (typical hourly rate is <0.01% on
  GMX V2 markets at moderate OI).

### Hedge EV math (estimated)

Per the existing `hedge-bot.ts` sizing model, at 9 corps × ~10 INF/op
× drug threshold 0.0039:

- `totalInfAtRisk = 9 × 10 = 90 INF` ≈ **$180** at current DIRTY price.
  ⚠ NOTE: the existing formula `totalInfAtRisk = corpsActive * infCostPerOp`
  treats `infCostPerOp` as USD. Per `CLAUDE.md` it's 9.12 INF (token units),
  not USD. **This appears to be a pre-existing units bug in `hedge-bot.ts`
  predating this brief — flag for the operator to confirm before adapting.**
- `notional = $180 / 0.0039 = $46,154`
- At 25x: `margin = $1,846`
- Round-trip trading fee: `$46k × 0.108% ≈ $50`
- Plus ~$0.15 in gas

For the hedge to be EV-positive, the average per-batch outcome needs to
be net-better than `-$50`. At ~50% win rate of the existing whale signal,
this is plausible. But the fee is non-trivial and worth modeling against
historical batches before going live.

---

## Oracle mismatch — Chainlink Data Streams vs RedStone

GMX uses **Chainlink Data Streams** with sequencer-level integration on
MegaETH. Per the announcement, prices are signed off-chain by Chainlink
keepers and delivered to GMX at execution time.

Our existing `redstone-price.ts` polls `0xc555c100..` (the on-chain
RedStone AggregatorV3) every 3s. Divergence with Chainlink Data Streams
is empirically unknown — we've only measured Hyperliquid-perp → RedStone
(max 3.86 bps).

### Risk

A short hedge is most exposed when:
- Our op fails (ETH dropped past threshold per RedStone)
- But GMX's Chainlink price hasn't dropped yet
- So our TP doesn't trigger — we hold a losing short while ETH bounces

### Mitigation (in the hedge-bot once adapted)

Set TP a small buffer ABOVE the game's liquidation price:

```ts
const ORACLE_BUFFER_BPS = 5;  // 0.05% — calibrate against shadow data
const tpPrice = liqPrice * (1 + ORACLE_BUFFER_BPS / 10000);
```

Better: log Chainlink's GMX-side price at every hedge open/close (read
via `Reader.getMarketTokenPrice`) and accumulate divergence stats in
the existing `oracle_divergence` table. After ~50 hedges we'll have
empirical data to size the buffer.

---

## Open questions / decisions needed before adapting hedge-bot

1. **50x leverage cap** — operator's 25x target is fine, but at 50x the
   stress-test math (1 ETH = +5% move) gets tighter. Confirm 25x stays.
2. **Pre-existing sizing units bug** in `hedge-bot.ts` (see "Hedge EV
   math" above) — does `infCostPerOp` mean USD or INF tokens? Probably
   needs a `× DIRTY/USDM rate` multiplier somewhere.
3. **Fee budget** — $50 round-trip on a $46k hedge. Set a minimum
   hedge-worth threshold (`hedgeMinNotional`) so we don't bother
   hedging tiny 1-2 corp batches where fees eat the EV.
4. **Approval strategy** — `MaxUint256` approve to Router once and
   forget, or per-order exact? `MaxUint256` is the GMX V2 norm but
   the operator may prefer tighter control.
5. **Keeper failure mode** — if a keeper goes down (network-wide), our
   `createOrder` succeeds but never executes. The position never opens
   but the executionFee is locked. Need a "stale order cancel" path
   if no execution within ~30s.
6. **POC authorization** — `scripts/gmx-poc.ts` is drafted but NOT yet
   run. It requires `MAIN_KEY` to sign real txs (max loss $5 + ~$0.30
   fees). The brief authorizes a tiny POC; operator can run via
   `npm run gmx-poc` after reviewing the script.

---

## References

- GMX V2 contract source: <https://github.com/gmx-io/gmx-synthetics>
  - `contracts/router/ExchangeRouter.sol` — entry point
  - `contracts/router/BaseRouter.sol` — `sendWnt`, `sendTokens`
  - `contracts/order/Order.sol` — OrderType enum
  - `contracts/order/IBaseOrderUtils.sol` — CreateOrderParams struct
- GMX docs (rendered):
  - <https://docs.gmx.io/docs/api/contracts/addresses/>
  - <https://docs.gmx.io/docs/api/contracts/overview/>
- MegaETH launch announcement:
  <https://gmxio.substack.com/p/gmx-is-now-live-on-megaeth-trade>
- Governance proposal:
  <https://gov.gmx.io/t/gmx-v2-deployment-on-megaeth-proposal/4954>
