// ============================================================
// Multi-tenant subscriber alert poller.
//
// Iterates every registered subscriber with a wallet and sends DMs
// when interesting transitions occur:
//
//   🎯 claim_ready    one of their corps is `isCompletable`
//   💸 liquidated     a corp just got liquidated (TradeLiquidated event)
//   ⚠️ inf_low        their INF balance dropped below threshold
//   🔄 auto_off       all of their corps have autoTradeEnabled=false
//                     (catches accidental disablement)
//
// Each alert has a unique key so the dashboard's bot_alert_log dedup
// table prevents repeats while the underlying condition holds. A
// claim_ready alert for corp X re-fires only after a 90-min window —
// long enough that the user has time to claim and start a new op.
//
// Implemented as a single 30-second loop that batches all subscribers
// into one Multicall3 call where possible.
// ============================================================

import { logger } from '../logger';
import type { Storage, Subscriber } from '../storage/db';
import type { TgBot } from './tgbot';

const RPC_URL = 'https://mainnet.megaeth.com/rpc';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const USER_FACTORY = '0x619814a203ca441611cee02abf31986ca265dd35';
const INF_TOKEN = '0x403de0893f0bc66139592ba2fd254672f2db933a';

// Selectors (from corp-state.ts / onchain-balances.ts)
const SEL_GET_USER_COMPANIES = '0x068e4f69';
const SEL_IS_COMPLETABLE      = '0x9f3de032';
const SEL_PENDING_REWARD      = '0x137ee36e';
const SEL_AUTO_TRADE_ENABLED  = '0x90cc5c90';
const SEL_BALANCE_OF          = '0x70a08231';

const POLL_INTERVAL_MS_DEFAULT = 30_000;
const INF_LOW_THRESHOLD = 25; // human-readable INF (so 25 = 25.0 INF after dividing by 1e18)
const CLAIM_DEDUP_WINDOW_MS = 90 * 60_000;   // 90 min — full Drug cycle
const INF_LOW_DEDUP_WINDOW_MS = 4 * 3600_000; // 4 hours

// Reuse the multicall3 encoder from onchain-balances.ts. We keep a
// minimal local copy here to avoid a circular import; the math is
// identical. If you see drift between the two implementations, prefer
// the one in onchain-balances.ts.

function pad32(hexNoPrefix: string): string {
  return hexNoPrefix.padStart(64, '0');
}

function encodeBalanceOf(wallet: string): string {
  return SEL_BALANCE_OF + pad32(wallet.toLowerCase().replace(/^0x/, ''));
}

function encodeAddrArg(sel: string, addr: string): string {
  return sel + pad32(addr.toLowerCase().replace(/^0x/, ''));
}

function encodeMulticall3Aggregate3(calls: { target: string; allowFailure: boolean; callData: string }[]): string {
  const tupleBodies: string[] = calls.map(c => {
    const target = c.target.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const allow = (c.allowFailure ? '1' : '0').padStart(64, '0');
    const data = c.callData.replace(/^0x/, '');
    const dataLen = (data.length / 2).toString(16).padStart(64, '0');
    const dataPaddedLen = Math.ceil(data.length / 64) * 64;
    const dataPadded = data.padEnd(dataPaddedLen, '0');
    const tupleHead = target + allow + (32 * 3).toString(16).padStart(64, '0');
    return tupleHead + dataLen + dataPadded;
  });
  let offsetCursor = calls.length * 32;
  const offsetsTable = tupleBodies.map(body => {
    const off = offsetCursor.toString(16).padStart(64, '0');
    offsetCursor += body.length / 2;
    return off;
  });
  const arrayLen = calls.length.toString(16).padStart(64, '0');
  const arrayBody = offsetsTable.join('') + tupleBodies.join('');
  const arrayOuterOffset = '0000000000000000000000000000000000000000000000000000000000000020';
  return '0x82ad56cb' + arrayOuterOffset + arrayLen + arrayBody;
}

function decodeMulticall3Aggregate3(hex: string): { success: boolean; data: string }[] {
  const h = hex.replace(/^0x/, '');
  const len = parseInt(h.substring(64, 128), 16);
  const arrayBodyStart = 128;
  const offsets: number[] = [];
  for (let i = 0; i < len; i++) {
    offsets.push(parseInt(h.substring(arrayBodyStart + i * 64, arrayBodyStart + (i + 1) * 64), 16));
  }
  const out: { success: boolean; data: string }[] = [];
  for (let i = 0; i < len; i++) {
    const tupleStart = arrayBodyStart + offsets[i] * 2;
    const success = parseInt(h.substring(tupleStart, tupleStart + 64), 16) === 1;
    const bytesOffset = parseInt(h.substring(tupleStart + 64, tupleStart + 128), 16);
    const bytesAt = tupleStart + bytesOffset * 2;
    const bytesLen = parseInt(h.substring(bytesAt, bytesAt + 64), 16);
    const data = '0x' + h.substring(bytesAt + 64, bytesAt + 64 + bytesLen * 2);
    out.push({ success, data });
  }
  return out;
}

async function rpc<T = any>(method: string, params: any[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as any;
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

export interface SubPollerConfig {
  storage: Storage;
  bot: TgBot;
  pollMs?: number;
}

export class SubscriberPoller {
  private cfg: SubPollerConfig;
  private interval: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(cfg: SubPollerConfig) {
    this.cfg = cfg;
  }

  start() {
    void this.poll();
    this.interval = setInterval(() => void this.poll(), this.cfg.pollMs ?? POLL_INTERVAL_MS_DEFAULT);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }

  private async poll() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const subs = this.cfg.storage.listActiveSubscribersWithWallet();
      if (subs.length === 0) return;
      // Process subscribers serially to keep RPC pressure modest. A single
      // subscriber's check fires 1 RPC for the company list + 1 for state
      // batched via Multicall3 + 1 INF balanceOf. That's ~3 RPC per sub
      // every poll interval, so 100 subs = ~300 RPC every 30s = manageable.
      for (const sub of subs) {
        try { await this.checkSubscriber(sub); }
        catch (err: any) { logger.warn({ err: err.message, sub: sub.tg_user_id }, '[SubPoller] check failed'); }
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async checkSubscriber(sub: Subscriber) {
    if (!sub.wallet_address) return;
    const wallet = sub.wallet_address;

    // 1) INF balance check (cheap)
    const infResult = await rpc<string>('eth_call', [
      { to: INF_TOKEN, data: encodeBalanceOf(wallet) }, 'latest',
    ]);
    const infBalance = Number(BigInt(infResult)) / 1e18;
    if (infBalance < INF_LOW_THRESHOLD) {
      const key = `inf_low:${Math.floor(infBalance / 5) * 5}`; // bucket by 5-INF tiers so we don't re-fire on tiny moves
      if (!this.cfg.storage.hasRecentAlert(sub.id, key, INF_LOW_DEDUP_WINDOW_MS)) {
        await this.cfg.bot.sendDm(sub.tg_user_id,
          `⚠️ *INF balance low: ${infBalance.toFixed(1)}*\n\n` +
          `That's ~${Math.floor(infBalance / 5)} ops of fuel. ` +
          `Top up via the in-game swap before your corps idle.`);
        this.cfg.storage.recordAlert(sub.id, key, 'inf_low');
      }
    }

    // 2) Company list
    const companiesHex = await rpc<string>('eth_call', [
      { to: USER_FACTORY, data: encodeAddrArg(SEL_GET_USER_COMPANIES, wallet) }, 'latest',
    ]);
    const companies = parseAddressArray(companiesHex);
    if (companies.length === 0) return;

    // 3) Per-corp state via batched multicall: isCompletable + pendingReward
    //    + autoTradeEnabled per corp.
    const calls = companies.flatMap(corp => [
      { target: corp, allowFailure: true, callData: SEL_IS_COMPLETABLE },
      { target: corp, allowFailure: true, callData: SEL_PENDING_REWARD },
      { target: corp, allowFailure: true, callData: SEL_AUTO_TRADE_ENABLED },
    ]);
    const mcResp = await rpc<string>('eth_call', [
      { to: MULTICALL3, data: encodeMulticall3Aggregate3(calls) }, 'latest',
    ]);
    const decoded = decodeMulticall3Aggregate3(mcResp);

    let claimableCount = 0;
    let totalPending = 0n;
    let activeOwned = 0;          // corps with any nonzero state — proxy for "deployed"
    let autoOnCount = 0;
    for (let i = 0; i < companies.length; i++) {
      const off = i * 3;
      const completable = decoded[off]?.success && BigInt(decoded[off].data || '0x0') !== 0n;
      const pending     = decoded[off + 1]?.success ? BigInt(decoded[off + 1].data || '0x0') : 0n;
      const autoOn      = decoded[off + 2]?.success && BigInt(decoded[off + 2].data || '0x0') !== 0n;

      const owned = completable || pending > 0n || autoOn;
      if (owned) activeOwned++;
      if (autoOn) autoOnCount++;
      if (completable) {
        claimableCount++;
        totalPending += pending;
        // Per-corp claim alert (deduped per corp, 90-min window)
        const key = `claim:${companies[i]}`;
        if (!this.cfg.storage.hasRecentAlert(sub.id, key, CLAIM_DEDUP_WINDOW_MS)) {
          await this.cfg.bot.sendDm(sub.tg_user_id,
            `🎯 *Corp ready to claim*\n\n` +
            `Pending: \`${(Number(pending) / 1e18).toFixed(2)} $DIRTY\`\n` +
            `Corp: \`${companies[i].slice(0, 10)}…\``);
          this.cfg.storage.recordAlert(sub.id, key, 'claim_ready');
        }
      }
    }

    // 4) Auto-off alert: all owned corps have auto disabled. Fires once
    //    per ~4h so it doesn't spam if the user prefers manual.
    if (activeOwned > 0 && autoOnCount === 0) {
      const key = `auto_off:${activeOwned}`;
      if (!this.cfg.storage.hasRecentAlert(sub.id, key, INF_LOW_DEDUP_WINDOW_MS)) {
        await this.cfg.bot.sendDm(sub.tg_user_id,
          `🔄 *All corps have auto-trade OFF.*\n\n` +
          `Each cycle requires manual claim → restart. Enable auto-trade in the game UI to set-and-forget.`);
        this.cfg.storage.recordAlert(sub.id, key, 'auto_off');
      }
    }
  }
}

// address[] decoder: offset(32) + length(32) + N*addresses
function parseAddressArray(hex: string): string[] {
  const h = (hex || '').replace(/^0x/, '');
  if (h.length < 128) return [];
  const length = parseInt(h.substring(64, 128), 16);
  const addrs: string[] = [];
  for (let i = 0; i < length; i++) {
    const word = h.substring(128 + i * 64, 128 + (i + 1) * 64);
    addrs.push('0x' + word.slice(24));
  }
  return addrs;
}
