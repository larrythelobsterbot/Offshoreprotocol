# World Exchange (Composite) SDK notes

Findings from inspecting `@wcm-inc/sdk@0.0.4` + `@wcm-inc/abi@0.0.4` installed
2026-05-11. Used to plan the Phase 2 POC + Phase 3 hedge bot.

## Packages

- `@wcm-inc/sdk` — high-level client. Re-exports `@wcm/tools` and `bignumber.js`.
- `@wcm-inc/abi` — generated ABIs (`generated/*.ts`). No embedded addresses.

Single transient `npm audit` finding: `fast-uri <=3.1.1` high-severity path-traversal
in a transitive dep. Non-blocking for our use (we don't parse arbitrary URIs through
the lib). Flag if it sticks around.

## Core classes (from `portfolio-kW_3Ghxe.d.ts`)

```ts
declare class Exchange {            // entrypoint; constructed once per process
declare class PerpOrderBook { ... } // one per market (ETH-USDM perp etc.)
declare class SpotOrderBook { ... }
declare class LendOrderBook { ... }
declare class ERC20 { ... }          // SDK wrapper around an ERC20 contract
declare class Portfolio { ... }      // risk/leverage math, not for trading
```

`BullishBasisStrategy` (in `@wcm-inc/sdk/strategies`) shows the canonical pattern
for combined lend+spot+perp orders. Pattern is `static init(portfolio, tokenId, exchange)`.

## Instantiation

```ts
import { Exchange, PerpOrderBook, OrderType, BigNumber } from '@wcm-inc/sdk';
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider(process.env.MEGA_RPC_URL);
const wallet   = new ethers.Wallet(process.env.MAIN_KEY!, provider);

const exchange = new Exchange({
  contractAddress: process.env.WORLD_EXCHANGE_ADDRESS!,  // operator-supplied
  signer: wallet,
  // ContractMethodsRunnerSettings — defaults usually fine
});
```

`Exchange` exposes:
- `createAccount(options?)` — first-time setup
- `getAccountId({ address? })` — returns `bigint`; throws if no account
- `approveErc20({ erc20, amount })`
- `depositErc20({ erc20, amount })`
- `approveAndDepositErc20({ erc20, amount })` ← **POC uses this**
- `createAccountAndDepositErc20({ erc20, amount })` ← if no account yet
- `withdrawErc20({ erc20, amount })`
- `getAggregatedPerpPosition({ tokenId, accountId? })` → `AggregatedPerpPosition`
- `getAllBulkVaultTokenConfigs()` → array of `VaultTokenConfig` (lists every
  ERC20 onboarded to the exchange; lets us find USDM's `tokenId` from its address)
- `getOrderBookConfig({ address })` → `OrderBookConfig`
- `getERC20({ erc20 })` → SDK ERC20 wrapper

`PerpOrderBook` is constructed directly with `new PerpOrderBook(exchange, chainId,
address, buyToken, sellToken, runner)`. The address must come from the operator
(no on-chain enumeration method we found). `getOrderBookConfig` gives us
`buyToken` + `sellToken` configs.

## Order types

```ts
enum OrderType {
  Limit               = 0,  // posts; may fill later
  FillAllOrRevert     = 2,  // IOC-all or revert
  FillPartialKillRest = 3,  // ← market-equivalent (cross book, cancel residue)
}
```

There is no separate "Market" order type. "Market sell at slippage X" =
`createShortOrder({ price: fillingPrice, quantity, type: FillPartialKillRest })`
where `fillingPrice` comes from `perpOrderBook.getMarketShortOrder(...)`.

## Opening a short

```ts
// 1. Probe the book to find a tolerable execution price
const { fillingPrice, filledQuantity } = await perpOrderBook.getMarketShortOrder(
  { quantity: '0.05', slippage: 0.01 }, // 1% slippage tolerance
  { limit: 50 },
);

// 2. Place the order
await perpOrderBook.createShortOrder({
  quantity: filledQuantity,
  price:    fillingPrice,
  type:     OrderType.FillPartialKillRest,
});
```

`SpotOrderDataInput` (same shape used for perp orders despite the name):

```ts
{
  accountId?: bigint;  // omitted → derived from signer
  quantity:   BigNumber.Value;
  price:      BigNumber.Value;
  type?:      OrderType;       // defaults to Limit
  insertionHint?: bigint;       // book-position optimisation; can omit
}
```

## Closing a short

Same as opening a long: `createLongOrder({...})` with `FillPartialKillRest`. World
has no built-in "close position" primitive — you just place an offsetting trade.

## Take-profit

There is no `setTakeProfit` primitive. Implementation pattern: place an
additional LIMIT long order at the TP price. If the market reaches that price,
it executes and closes (or reduces) the short.

Caveat: World's matching engine doesn't enforce reduce-only at the SDK level. A
limit long order at TP can over-fill and flip the position from short → long if
the operator isn't careful with quantity. Hedge bot must size the TP order
exactly to the open short quantity.

## Reading positions

```ts
const pos = await exchange.getAggregatedPerpPosition({
  tokenId: ETH_PERP_TOKEN_ID,    // index in Exchange's vault token list
});
// pos: { startTime, price, quantity, owedBase, owedNom }
// quantity > 0 = long, < 0 = short
```

## Authentication

Single signer pattern — pass `signer: wallet` into the Exchange constructor.
The SDK accepts a split signer (`{ trader, owner }`) for permissioned setups
but we use one wallet (`MAIN_KEY`).

## Fees

`Exchange.FEE_DIVISOR = 100000`. Fee multipliers come back on the
`OrderBookConfig`: `takerFeeMultiplier`, `makerFeeMultiplier`, `fromMaxFee`,
`toMaxFee`. Max fee per trade is capped — brief says $10/trade on ETH perp.

## Missing pieces / things to verify in the POC

- **Exact `WORLD_EXCHANGE_ADDRESS`**: not findable programmatically. Operator
  must grab it from the World UI (gear icon, upper right).
- **ETH perp order book address**: operator must supply via env.
  Alternative: scan `getAllBulkVaultTokenConfigs()` and inspect the exchange's
  events to find perp-book deployment txs, but that's expensive vs just asking.
- **USDM `tokenId`**: discoverable. After connecting, call
  `getAllBulkVaultTokenConfigs()` and match on `tokenAddress ===
  0xfafddbb3fc7688494971a79cc65dca3ef82079e7`.
- **Funding rate impact** on holding a short for 90 minutes — needs measurement
  during POC. `getFundingRateStats()` exists on the book.

## Address inputs (operator must supply)

Add to `.env`:

```
WORLD_EXCHANGE_ADDRESS=0x…       # Exchange contract on MegaETH
WORLD_ETH_PERP_BOOK=0x…          # ETH/USDM perp order book address
```

USDM tokenId is auto-discovered from the exchange's vault config at runtime.
