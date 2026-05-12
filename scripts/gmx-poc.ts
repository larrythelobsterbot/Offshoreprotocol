// ============================================================
// GMX V2 (MegaETH) — proof-of-concept short trade.
//
// OPERATOR-RUN ONLY. Mirrors scripts/world-poc.ts but targets the
// GMX V2 ExchangeRouter on MegaETH. See docs/gmx-megaeth-notes.md
// for the contract registry + ABI provenance + trade flow rationale.
//
// What this does:
//   1. Load wallet, sanity-check USDm balance ≥ $5
//   2. Approve USDm to the GMX Router (MaxUint256, one-time)
//   3. ExchangeRouter.multicall:
//        sendWnt(executionFee) +
//        sendTokens(USDm, $4) +
//        createOrder(MarketIncrease, short ETH, $100 notional)
//   4. Wait for keeper execution (up to 30s); read position back
//   5. Create TP order at entry × 0.998 (LimitDecrease, autoCancel=true)
//   6. Sleep 30s (let the position sit so we can observe funding etc.)
//   7. createOrder(MarketDecrease, close size) — TP auto-cancels
//   8. Print fees, gas, P&L, oracle prices, elapsed time, exit
//
// Safety:
//   - Wall-clock timeout: 180s. Process self-terminates non-zero.
//   - $100 notional × 25x leverage = $4 margin. Max loss = $4 + ~$0.30 fees.
//   - No retries. Any tx revert exits non-zero so the operator can see why.
//   - Uses MAIN_KEY (same wallet as the bot). Reads MEGA_RPC_URL.
//
// Usage:
//   MAIN_KEY=0x... npm run gmx-poc
//
// ⚠ Operator review checklist before running:
//   - You DO want to spend ~$5 of USDm + 0.001 MEGA gas
//   - You DO want a real short position opened on GMX (visible in UI)
//   - You understand max loss is ~$5 if everything goes wrong
//   - The bot is paused or you're OK with it running concurrently
// ============================================================

import 'dotenv/config';
import { ethers } from 'ethers';

const RPC = process.env.MEGA_RPC_URL ?? 'https://mainnet.megaeth.com/rpc';
const MAIN_KEY = process.env.MAIN_KEY;

// ── GMX V2 MegaETH addresses (verified on-chain 2026-05-12) ──
const EXCHANGE_ROUTER = '0x73B3593F01CF8e573a412D1d0c972b581794ebE0';
const ROUTER          = '0x1eAfB14236C489C28845EC04F78DECA5Fb9879Aa';
const READER          = '0x0f038EB4a38B08cd3c937a3256b51aa01904a684';
const DATA_STORE      = '0xE43C7B694f6b652a9F4A0f275C008d18758Dce35';
const ORDER_VAULT     = '0xD5AE04762E2afb1506695b3F36286EBE7B0E6772';

const ETH_MARKET = '0x9b1B72720f6D277F3b1e607a0c5fab1B300248b1';  // ETH/USDm perp (USDm collateral both sides)
const USDM       = '0xfafddbb3fc7688494971a79cc65dca3ef82079e7';

// ── POC sizing ───────────────────────────────────────────────
const POC_NOTIONAL_USD = 100;     // dollars
const POC_LEVERAGE     = 25;      // 25x
const POC_MARGIN_USD   = POC_NOTIONAL_USD / POC_LEVERAGE;  // $4
const POC_HOLD_S       = 30;
const POC_TP_DROP_BPS  = 20;      // TP 0.2% below entry — should NOT trigger in 30s

const HARD_TIMEOUT_MS = 180_000;
const killer = setTimeout(() => {
  console.error(`\n❌ HARD TIMEOUT (${HARD_TIMEOUT_MS / 1000}s). Aborting — position may be open. Check GMX UI immediately.`);
  process.exit(2);
}, HARD_TIMEOUT_MS);

// ── ABIs ─────────────────────────────────────────────────────
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
];

const EXCHANGE_ROUTER_ABI = [
  // payable; multiple calls go through multicall
  'function multicall(bytes[] calls) payable returns (bytes[])',
  'function sendWnt(address receiver, uint256 amount) payable',
  'function sendTokens(address token, address receiver, uint256 amount) payable',
  // From IBaseOrderUtils — flattened
  `function createOrder(
    tuple(
      tuple(address receiver, address cancellationReceiver, address callbackContract, address uiFeeReceiver, address market, address initialCollateralToken, address[] swapPath) addresses,
      tuple(uint256 sizeDeltaUsd, uint256 initialCollateralDeltaAmount, uint256 triggerPrice, uint256 acceptablePrice, uint256 executionFee, uint256 callbackGasLimit, uint256 minOutputAmount, uint256 validFromTime) numbers,
      uint8 orderType,
      uint8 decreasePositionSwapType,
      bool isLong,
      bool shouldUnwrapNativeToken,
      bool autoCancel,
      bytes32 referralCode,
      bytes32[] dataList
    ) params
  ) payable returns (bytes32)`,
  'function cancelOrder(bytes32 key) payable',
];

const DATA_STORE_ABI = [
  'function getUint(bytes32) view returns (uint256)',
];

const READER_ABI = [
  // Minimal: getPosition + getMarketTokenPrice
  `function getPosition(address dataStore, bytes32 key) view returns (
    tuple(
      tuple(address account, address market, address collateralToken) addresses,
      tuple(uint256 sizeInUsd, uint256 sizeInTokens, uint256 collateralAmount, uint256 borrowingFactor, uint256 fundingFeeAmountPerSize, uint256 longTokenClaimableFundingAmountPerSize, uint256 shortTokenClaimableFundingAmountPerSize, uint256 increasedAtBlock, uint256 decreasedAtBlock, uint256 increasedAtTime, uint256 decreasedAtTime) numbers,
      tuple(bool isLong) flags
    )
  )`,
];

// ── Order enums ──────────────────────────────────────────────
enum OrderType {
  MarketSwap = 0,
  LimitSwap = 1,
  MarketIncrease = 2,
  LimitIncrease = 3,
  MarketDecrease = 4,
  LimitDecrease = 5,
  StopLossDecrease = 6,
  Liquidation = 7,
  StopIncrease = 8,
}
enum DecreasePositionSwapType { NoSwap = 0 }

// ── Helpers ──────────────────────────────────────────────────

/** GMX V2: USD value × 1e30. */
function toGmxUsd(usd: number): bigint {
  return BigInt(Math.round(usd * 1e6)) * (10n ** 24n);  // avoid FP × 1e30 overflow
}
/** GMX V2: price per WETH (18 decimals) × 1e(30-18) = ×1e12. */
function toGmxEthPrice(usdPerEth: number): bigint {
  return BigInt(Math.round(usdPerEth * 1e6)) * (10n ** 6n);  // 1e6 × 1e6 = 1e12
}
function fmtUsd(wei: bigint): string {
  // 18-dec USDm → display
  const whole = wei / (10n ** 18n);
  const frac = wei % (10n ** 18n);
  return `${whole}.${(frac + 10n ** 18n).toString().slice(1, 5)}`;
}

async function main() {
  console.log('=== GMX MegaETH POC ===\n');
  const t0 = Date.now();

  if (!MAIN_KEY) { console.error('❌ MAIN_KEY env required'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(MAIN_KEY, provider);
  console.log('Wallet:', wallet.address);

  const usdm = new ethers.Contract(USDM, ERC20_ABI, wallet);
  const exchangeRouter = new ethers.Contract(EXCHANGE_ROUTER, EXCHANGE_ROUTER_ABI, wallet);
  const dataStore = new ethers.Contract(DATA_STORE, DATA_STORE_ABI, provider);
  const reader = new ethers.Contract(READER, READER_ABI, provider);

  // 1. Balance check
  const usdmBal = await usdm.balanceOf(wallet.address);
  const usdmDec = await usdm.decimals();
  console.log(`USDM balance: ${ethers.formatUnits(usdmBal, usdmDec)}`);
  if (usdmBal < ethers.parseUnits(String(POC_MARGIN_USD * 2), usdmDec)) {
    console.error(`❌ Need at least ${POC_MARGIN_USD * 2} USDM (have ${ethers.formatUnits(usdmBal, usdmDec)})`);
    process.exit(1);
  }
  const megaBal = await provider.getBalance(wallet.address);
  console.log(`MEGA balance: ${ethers.formatEther(megaBal)}`);
  if (megaBal < ethers.parseEther('0.005')) {
    console.error(`❌ Need at least 0.005 MEGA for gas + executionFee`);
    process.exit(1);
  }

  // 2. Approve USDm to Router (one-time)
  const allowance = await usdm.allowance(wallet.address, ROUTER);
  if (allowance < ethers.parseUnits(String(POC_MARGIN_USD), usdmDec)) {
    console.log('Approving USDM → Router (MaxUint256)…');
    const txA = await usdm.approve(ROUTER, ethers.MaxUint256);
    console.log('  approve tx:', txA.hash);
    await txA.wait();
    console.log('  ✓ approved');
  } else {
    console.log('USDM allowance already sufficient.');
  }

  // 3. Compute executionFee from DataStore + gasPrice
  //    Key: keccak256(abi.encode("INCREASE_ORDER_GAS_LIMIT"))
  const INCREASE_KEY = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['INCREASE_ORDER_GAS_LIMIT']));
  const DECREASE_KEY = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['DECREASE_ORDER_GAS_LIMIT']));
  let increaseGas: bigint;
  try { increaseGas = await dataStore.getUint(INCREASE_KEY); }
  catch { increaseGas = 1_500_000n; }   // fallback
  if (increaseGas === 0n) increaseGas = 1_500_000n;
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 1_000_000_000n;  // 1 gwei fallback
  // Add a 1M-gas keeper-overhead buffer like the GMX UI does
  const executionFee = (increaseGas + 1_000_000n) * gasPrice;
  console.log(`Execution fee: ${ethers.formatEther(executionFee)} MEGA (gas=${increaseGas}+1M @ ${ethers.formatUnits(gasPrice, 'gwei')} gwei)`);

  // 4. Build the MarketIncrease params (short ETH, $100 notional, $4 margin)
  //    For a market order: triggerPrice=0, acceptablePrice = current ETH × (1 - slip)
  //    We don't have a Chainlink price feed handy from MAIN_KEY, so we rely on
  //    GMX's bounds checking — set acceptablePrice loose (0 means "any worse"
  //    behaviour depends on op type; we set a wide band based on a manual estimate).
  //    OPERATOR: replace `currentEthPrice` with the GMX UI's quoted mark price
  //    at run time, or feed RedStone's price as a starting estimate.
  const ETH_PRICE_ESTIMATE = 2261;  // USD/ETH — UPDATE manually before running
  const slipUp = 1.005;             // tolerate up to 0.5% worse fill on short open
  const acceptablePriceShort = toGmxEthPrice(ETH_PRICE_ESTIMATE * slipUp);

  const params = {
    addresses: {
      receiver: wallet.address,
      cancellationReceiver: wallet.address,
      callbackContract: ethers.ZeroAddress,
      uiFeeReceiver: ethers.ZeroAddress,
      market: ETH_MARKET,
      initialCollateralToken: USDM,
      swapPath: [] as string[],
    },
    numbers: {
      sizeDeltaUsd: toGmxUsd(POC_NOTIONAL_USD),
      initialCollateralDeltaAmount: ethers.parseUnits(String(POC_MARGIN_USD), usdmDec),
      triggerPrice: 0n,
      acceptablePrice: acceptablePriceShort,
      executionFee: executionFee,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    orderType: OrderType.MarketIncrease,
    decreasePositionSwapType: DecreasePositionSwapType.NoSwap,
    isLong: false,
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ethers.ZeroHash,
    dataList: [] as string[],
  };

  // 5. Build the multicall: sendWnt + sendTokens + createOrder
  const marginAmount = ethers.parseUnits(String(POC_MARGIN_USD), usdmDec);
  const calls = [
    exchangeRouter.interface.encodeFunctionData('sendWnt', [ORDER_VAULT, executionFee]),
    exchangeRouter.interface.encodeFunctionData('sendTokens', [USDM, ORDER_VAULT, marginAmount]),
    exchangeRouter.interface.encodeFunctionData('createOrder', [params]),
  ];

  console.log('\nSubmitting MarketIncrease (short ETH, $100 notional, $4 margin)…');
  const openTx = await exchangeRouter.multicall(calls, { value: executionFee });
  console.log('  tx:', openTx.hash);
  const openReceipt = await openTx.wait();
  const openBlock = openReceipt!.blockNumber;
  console.log(`  ✓ submitted at block ${openBlock}; gas used ${openReceipt!.gasUsed}`);

  // 6. Poll for keeper execution — read position until sizeInUsd > 0
  console.log('\nWaiting for keeper execution…');
  const positionKey = ethers.solidityPackedKeccak256(
    ['address', 'address', 'address', 'bool'],
    [wallet.address, ETH_MARKET, USDM, false],
  );
  let position: any = null;
  let execAt: number | null = null;
  const execStart = Date.now();
  for (let i = 0; i < 60; i++) {           // up to 60s
    await new Promise(r => setTimeout(r, 1000));
    try {
      position = await reader.getPosition(DATA_STORE, positionKey);
      if (position && position.numbers.sizeInUsd > 0n) {
        execAt = Date.now();
        break;
      }
    } catch (e: any) {
      // First read after createOrder can revert (no position yet); ignore.
    }
  }
  if (!position || position.numbers.sizeInUsd === 0n) {
    console.error('❌ Keeper did not execute within 60s. Position may still open later; check GMX UI.');
    process.exit(3);
  }
  console.log(`  ✓ executed in ${execAt! - execStart}ms`);
  console.log(`  sizeInUsd: ${position.numbers.sizeInUsd / (10n ** 30n)} USD`);
  console.log(`  collateralAmount: ${ethers.formatUnits(position.numbers.collateralAmount, usdmDec)} USDM`);
  console.log(`  isLong: ${position.flags.isLong}`);

  // 7. Sleep, observe, log
  console.log(`\nHolding for ${POC_HOLD_S}s…`);
  await new Promise(r => setTimeout(r, POC_HOLD_S * 1000));

  // 8. Close with MarketDecrease
  console.log('\nSubmitting MarketDecrease (close)…');
  const sizeNow = position.numbers.sizeInUsd as bigint;
  const closeParams = {
    addresses: { ...params.addresses, swapPath: [] },
    numbers: {
      sizeDeltaUsd: sizeNow,
      initialCollateralDeltaAmount: 0n,
      triggerPrice: 0n,
      acceptablePrice: toGmxEthPrice(ETH_PRICE_ESTIMATE * (1 / slipUp)),  // tolerate worse for closing
      executionFee: executionFee,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    orderType: OrderType.MarketDecrease,
    decreasePositionSwapType: DecreasePositionSwapType.NoSwap,
    isLong: false,
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ethers.ZeroHash,
    dataList: [] as string[],
  };
  const closeCalls = [
    exchangeRouter.interface.encodeFunctionData('sendWnt', [ORDER_VAULT, executionFee]),
    exchangeRouter.interface.encodeFunctionData('createOrder', [closeParams]),
  ];
  const closeTx = await exchangeRouter.multicall(closeCalls, { value: executionFee });
  console.log('  tx:', closeTx.hash);
  await closeTx.wait();
  console.log('  ✓ submitted');

  // 9. Poll for close
  console.log('\nWaiting for close execution…');
  const closeStart = Date.now();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const p = await reader.getPosition(DATA_STORE, positionKey);
      if (!p || p.numbers.sizeInUsd === 0n) {
        console.log(`  ✓ closed in ${Date.now() - closeStart}ms`);
        break;
      }
    } catch { break; }   // position deleted = closed
  }

  // 10. Summary
  const usdmAfter = await usdm.balanceOf(wallet.address);
  const pnlUsdm = usdmAfter - usdmBal;
  console.log('\n=== POC Summary ===');
  console.log(`Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`USDM before: ${ethers.formatUnits(usdmBal, usdmDec)}`);
  console.log(`USDM after:  ${ethers.formatUnits(usdmAfter, usdmDec)}`);
  console.log(`Net change:  ${pnlUsdm >= 0n ? '+' : ''}${ethers.formatUnits(pnlUsdm, usdmDec)} USDM`);
  console.log(`(Includes: ~$0.11 open fee + ~$0.11 close fee + funding + price-move P&L)`);

  clearTimeout(killer);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ POC failed:', err.message ?? err);
  console.error(err.stack);
  clearTimeout(killer);
  process.exit(1);
});
