// ============================================================
// World Exchange (Composite) — proof-of-concept trade.
//
// Standalone, OPERATOR-RUN script (not invoked by the bot). Runs ONE
// minimal flow against World on MegaETH mainnet to validate the SDK
// integration before we wire the hedge bot:
//
//   1. Read live USDM balance + check for an existing World account
//   2. Create the account if needed, then deposit $10 USDM
//   3. Find the ETH-perp order book and probe its market-sell price
//   4. Open a $100-notional short (~$10 margin at 10x) using
//      FillPartialKillRest (market-equivalent)
//   5. Read the resulting position back
//   6. Wait 30 s
//   7. Close the short with an offsetting long at the live ask
//   8. Print fees, gas, P&L, total elapsed time, then exit
//
// Safety:
//   - Wall-clock timeout: 120 s. If any await hangs, the process
//     self-terminates with non-zero exit.
//   - Tiny position size — max loss is the margin + fees (~$10–$15).
//   - Uses MAIN_KEY (same wallet as the bot) on MegaETH.
//   - No retry loops. Any tx failure surfaces immediately so the
//     operator can investigate before we automate the path.
//
// Usage:
//   WORLD_EXCHANGE_ADDRESS=0x...  \
//   WORLD_ETH_PERP_BOOK=0x...     \
//   MAIN_KEY=0x...                \
//   npm run world-poc
// ============================================================

import 'dotenv/config';
import { ethers } from 'ethers';
import {
  Exchange,
  PerpOrderBook,
  OrderType,
  BigNumber,
} from '@wcm-inc/sdk';

const RPC = process.env.MEGA_RPC_URL ?? 'https://mainnet.megaeth.com/rpc';
const MAIN_KEY = process.env.MAIN_KEY;
const EXCHANGE_ADDR = process.env.WORLD_EXCHANGE_ADDRESS;
const PERP_BOOK_ADDR = process.env.WORLD_ETH_PERP_BOOK;
const USDM_ADDR = '0xfafddbb3fc7688494971a79cc65dca3ef82079e7';
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const POC_DEPOSIT_USDM = 10;        // dollars
const POC_NOTIONAL_USD = 100;       // $100 short
const POC_HOLD_SECONDS = 30;
const SLIPPAGE = 0.01;              // 1%

// Hard timeout so a hung await can't leave the process running.
const HARD_TIMEOUT_MS = 120_000;
const killer = setTimeout(() => {
  console.error(`\n❌ HARD TIMEOUT (${HARD_TIMEOUT_MS / 1000}s exceeded). Aborting.`);
  process.exit(2);
}, HARD_TIMEOUT_MS);
killer.unref();

function fmtUsd(v: number): string {
  return `$${v.toFixed(4)}`;
}

async function main() {
  console.log('=== World Exchange POC ===');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`RPC:  ${RPC}`);

  if (!MAIN_KEY)         throw new Error('MAIN_KEY env var required');
  if (!EXCHANGE_ADDR)    throw new Error('WORLD_EXCHANGE_ADDRESS env var required');
  if (!PERP_BOOK_ADDR)   throw new Error('WORLD_ETH_PERP_BOOK env var required');

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet   = new ethers.Wallet(MAIN_KEY, provider);
  console.log(`Wallet: ${wallet.address}`);

  const network = await provider.getNetwork();
  console.log(`Chain ID: ${network.chainId}`);

  // ── Step 1: USDM balance ──────────────────────────────────────────
  const usdm = new ethers.Contract(USDM_ADDR, ERC20_ABI, wallet);
  const usdmDecimals = Number(await usdm.decimals());
  const usdmRaw = await usdm.balanceOf(wallet.address);
  const usdmBal = Number(ethers.formatUnits(usdmRaw, usdmDecimals));
  console.log(`USDM (wallet):   ${fmtUsd(usdmBal)}`);
  if (usdmBal < POC_DEPOSIT_USDM) {
    throw new Error(`Need at least ${POC_DEPOSIT_USDM} USDM in wallet for POC; have ${usdmBal}`);
  }

  // ── Step 2: Exchange handle + account ─────────────────────────────
  const exchange = new Exchange({
    contractAddress: EXCHANGE_ADDR,
    signer: wallet,
  });

  let accountId: bigint;
  try {
    accountId = await exchange.getAccountId({ address: wallet.address });
    console.log(`World account:   ${accountId.toString()}`);
  } catch (err: any) {
    console.log('No World account yet — creating + depositing in one tx…');
    const receipt = await exchange.createAccountAndDepositErc20({
      erc20: USDM_ADDR,
      amount: POC_DEPOSIT_USDM,
    });
    console.log(`  createAccount tx: ${(receipt as any)?.hash ?? '(no hash returned)'}`);
    accountId = await exchange.getAccountId({ address: wallet.address });
    console.log(`World account:   ${accountId.toString()} (just created)`);
  }

  // ── Step 3: Top up if needed (idempotent path) ────────────────────
  // approveAndDepositErc20 handles the ERC20 allowance + deposit. We
  // only top up when the account has < $10 of USDM committed to it.
  // Reading the on-exchange balance requires the SDK's vault config;
  // for simplicity, we always deposit POC_DEPOSIT_USDM on this POC
  // run. If the operator wants to re-run the POC, they can adjust.
  console.log(`Depositing ${POC_DEPOSIT_USDM} USDM into World account…`);
  const depReceipt = await exchange.approveAndDepositErc20({
    erc20: USDM_ADDR,
    amount: POC_DEPOSIT_USDM,
  });
  console.log(`  deposit tx: ${(depReceipt as any)?.hash ?? '(no hash)'}`);

  // ── Step 4: Find the ETH perp order book ──────────────────────────
  const bookCfg = await exchange.getOrderBookConfig({ address: PERP_BOOK_ADDR });
  if (!bookCfg) throw new Error(`No order book config at ${PERP_BOOK_ADDR}`);
  console.log(`Perp book: ${PERP_BOOK_ADDR}`);
  console.log(`  buy token id:  ${(bookCfg as any).fromTokenConfig?.tokenId ?? '?'}`);
  console.log(`  sell token id: ${(bookCfg as any).toTokenConfig?.tokenId ?? '?'}`);

  // PerpOrderBook needs a ContractMethodsRunner — pull from exchange.
  // The SDK doesn't expose a convenience constructor, so we use
  // `new PerpOrderBook(...)` with the same fields the SDK exposes.
  const chainId = Number(network.chainId);
  // `exchange` carries the runner internally; the SDK's public
  // constructor takes it explicitly. We borrow it via cast — this is
  // the pattern the strategies module uses.
  const runner = (exchange as any).runner;
  if (!runner) {
    throw new Error('Could not access exchange.runner — SDK internals changed?');
  }
  const perpBook = new PerpOrderBook(
    exchange,
    chainId,
    PERP_BOOK_ADDR,
    (bookCfg as any).fromTokenConfig,
    (bookCfg as any).toTokenConfig,
    runner,
  );

  // ── Step 5: Probe market-sell price + size the short ──────────────
  // POC notional is $100. ETH quantity = 100 / price. Use a rough
  // current ETH price for sizing, then refine via getMarketShortOrder.
  // Use the operator's local RPC + RedStone if you want a precise
  // price; for the POC, we just probe the book at a placeholder
  // quantity and let the SDK return the realisable fill price.
  const ethQtyGuess = new BigNumber(POC_NOTIONAL_USD).dividedBy(2000); // ETH ≈ $2000 placeholder
  console.log(`Probing market-short at ~${ethQtyGuess.toFixed(6)} ETH (≈ $${POC_NOTIONAL_USD})…`);

  const probe = await perpBook.getMarketShortOrder(
    { quantity: ethQtyGuess.toString(), slippage: SLIPPAGE },
    { limit: 50 },
  );
  console.log(`  filling price:   ${probe.fillingPrice.toString()}`);
  console.log(`  filled quantity: ${probe.filledQuantity.toString()}`);

  if (probe.filledQuantity.isZero()) {
    throw new Error('Probe returned 0 fillable quantity. Order book may be empty.');
  }

  // ── Step 6: Open the short ─────────────────────────────────────────
  console.log('Placing short order (FillPartialKillRest)…');
  const t0 = Date.now();
  const openReceipt = await perpBook.createShortOrder({
    quantity: probe.filledQuantity,
    price:    probe.fillingPrice,
    type:     OrderType.FillPartialKillRest,
  });
  const openTx = (openReceipt as any);
  console.log(`  short tx:   ${openTx?.hash ?? '(no hash)'}`);
  console.log(`  open time:  ${Date.now() - t0} ms`);
  console.log(`  gas used:   ${openTx?.gasUsed?.toString() ?? '?'}`);

  // ── Step 7: Read the position back ────────────────────────────────
  const baseTokenId = Number((bookCfg as any).fromTokenConfig?.tokenId ?? 0);
  if (!baseTokenId) {
    console.warn('  (no base tokenId — skipping getAggregatedPerpPosition read)');
  } else {
    const pos = await exchange.getAggregatedPerpPosition({ tokenId: baseTokenId, accountId });
    console.log(`Position:`);
    console.log(`  quantity:  ${pos.quantity.toString()}`);
    console.log(`  price:     ${pos.price.toString()}`);
    console.log(`  startTime: ${pos.startTime?.toISOString?.() ?? '?'}`);
  }

  // ── Step 8: Hold POC_HOLD_SECONDS ─────────────────────────────────
  console.log(`Holding ${POC_HOLD_SECONDS}s…`);
  await new Promise((r) => setTimeout(r, POC_HOLD_SECONDS * 1000));

  // ── Step 9: Close the short with an offsetting long ───────────────
  console.log('Probing market-long to close…');
  const closeProbe = await perpBook.getMarketLongOrder(
    { quantity: probe.filledQuantity.toString(), slippage: SLIPPAGE },
    { limit: 50 },
  );
  console.log(`  close price:    ${closeProbe.fillingPrice.toString()}`);
  console.log(`  close quantity: ${closeProbe.filledQuantity.toString()}`);

  const t1 = Date.now();
  const closeReceipt = await perpBook.createLongOrder({
    quantity: closeProbe.filledQuantity,
    price:    closeProbe.fillingPrice,
    type:     OrderType.FillPartialKillRest,
  });
  const closeTx = (closeReceipt as any);
  console.log(`  close tx:   ${closeTx?.hash ?? '(no hash)'}`);
  console.log(`  close time: ${Date.now() - t1} ms`);
  console.log(`  gas used:   ${closeTx?.gasUsed?.toString() ?? '?'}`);

  // ── Step 10: Read post-close position + P&L summary ───────────────
  if (baseTokenId) {
    const finalPos = await exchange.getAggregatedPerpPosition({ tokenId: baseTokenId, accountId });
    console.log(`Post-close position:`);
    console.log(`  quantity: ${finalPos.quantity.toString()}  (should be ~0)`);
  }

  // Realised P&L is implicit in the exchange's USDM balance change.
  // We can't compute it cheanly without snapshotting before/after vault
  // balances — leave that as a manual diff for the operator.
  console.log('=== POC complete ===');
  console.log(`Total elapsed: ${Date.now() - t0} ms`);
  console.log('Inspect both tx hashes above on MegaETH explorer for full fee + P&L numbers.');
}

main()
  .then(() => { clearTimeout(killer); process.exit(0); })
  .catch((err) => {
    console.error('❌ POC FAILED:', err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    clearTimeout(killer);
    process.exit(1);
  });
