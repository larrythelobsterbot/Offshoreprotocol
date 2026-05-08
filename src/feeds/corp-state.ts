// ============================================================
// Per-corporation on-chain state feed.
//
// On startup (and every COMPANY_LIST_POLL_MS) we ask the
// UserFactory for the player's company addresses via
//   getUserCompanies(address) → address[]   (selector 0x068e4f69)
//
// Then every CORP_STATE_POLL_MS we batch a single Multicall3
// aggregate3 reading per-corp view functions for every company:
//   autoTradeEnabled()  → bool      (0x90cc5c90)
//   autoTradeMode()     → uint8     (0x9f6bc804)
//   getCooldownEnd()    → uint256   (0xd5cb5080)
//   hasPendingClaim()   → bool      (0xd3580c9f)
//   isCompletable()     → bool      (0x9f3de032)
//   isLiquidatable()    → bool      (0x578c65e4)
//   pendingReward()     → uint256   (0x137ee36e)
//   locationId()        → uint8     (0xe8aadc3f)
//   getTradeInfo()      → tuple     (0xd6694027)
//
// Selectors were derived from ABI fragments found in the compiled
// app bundle (assets/index-*.js) and confirmed against the live
// chain.
//
// The user's UserFactory is at:
//   0x619814a203ca441611cee02abf31986ca265dd35
// (Discovered by sweeping every address in the bundle for one
// that responds to getUserCompanies(0x30C620...) without revert.)
// ============================================================

import { EventEmitter } from 'events';
import { logger } from '../logger';

const RPC_URL = 'https://mainnet.megaeth.com/rpc';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const USER_FACTORY = '0x619814a203ca441611cee02abf31986ca265dd35';

const COMPANY_LIST_POLL_MS = 5 * 60_000; // refresh company list every 5 min
const CORP_STATE_POLL_MS_DEFAULT = 15_000;

const SEL = {
  getUserCompanies:    '0x068e4f69',
  autoTradeEnabled:    '0x90cc5c90',
  autoTradeMode:       '0x9f6bc804',
  getCooldownEnd:      '0xd5cb5080',
  hasPendingClaim:     '0xd3580c9f',
  isCompletable:       '0x9f3de032',
  isLiquidatable:      '0x578c65e4',
  pendingReward:       '0x137ee36e',
  locationId:          '0xe8aadc3f',
  getTradeInfo:        '0xd6694027',
} as const;

type SelKey = keyof typeof SEL;

// The order of fields read per corp; must match the index used when
// decoding the multicall response.
const PER_CORP_READS: SelKey[] = [
  'autoTradeEnabled',
  'autoTradeMode',
  'getCooldownEnd',
  'hasPendingClaim',
  'isCompletable',
  'isLiquidatable',
  'pendingReward',
  'locationId',
  'getTradeInfo',
];

export interface CorpState {
  address: string;
  index: number;
  autoTradeEnabled: boolean;
  autoTradeMode: number;
  cooldownEnd: number;        // unix seconds; 0 = no cooldown
  cooldownRemainSec: number;  // helper
  hasPendingClaim: boolean;
  isCompletable: boolean;
  isLiquidatable: boolean;
  pendingReward: number;      // $DIRTY (18 decimals applied)
  pendingRewardRaw: string;
  locationId: number;
  tradeInfo: {
    active: boolean;
    mode: number;
    entryPrice: string;       // raw string (uint256) — anchor ETH price at trade start, 1e18-scaled
    liqPrice: string;         // pre-computed lower liquidation bound = entryPrice * (1 - threshold)
    startTime: number;        // unix sec
    endTime: number;
    influence: string;        // raw INF (18 decimals)
    pending: string;          // some pending amount, format unclear
  } | null;
  // Per-op liquidation headroom — populated by enrichCorpStateWithHeadroom()
  // when the dashboard state is assembled (needs live ETH price). Null when
  // op is not active or ETH price is unavailable.
  opHeadroom: OpHeadroom | null;
  // Friendly labels
  modeLabel: string;          // "idle", "extortion?", "arms?", "drug?", or numeric
  locationLabel: string;
  // Status summary
  status: 'idle' | 'running' | 'claimable' | 'liquidatable' | 'unknown';
  ok: boolean;
}

/**
 * Real-time liquidation proximity for an active op. The contract pre-computes
 * `liqPrice = entryPrice × (1 − threshold)` at trade start (where threshold is
 * 0.039% / 0.176% / 0.518% for Ext / Arms / Drug).
 *
 * Liquidation is ONE-SIDED DOWN: the contract only liquidates when ETH drops
 * below liqPrice. ETH rising above the anchor is fully safe — there's no
 * upper bound. (Verified by operator + by inspecting on-chain liquidation
 * events: every recorded liquidation has ethPriceAtLiq ≤ anchor.)
 *
 * Headroom is the percentage of the safety band remaining toward the lower
 * bound:
 *   100% = ETH at or above the anchor (max safety, no upside risk)
 *     0% = ETH at the lower liq bound (about to liquidate)
 *    <0% = past the lower bound (corp will be marked liquidatable next tick)
 */
export interface OpHeadroom {
  headroomPct: number;          // 0-100, lower = more dangerous (one-sided down)
  ethPrice: number;             // current live ETH (USD)
  anchorPrice: number;          // entryPrice (USD)
  lowerBound: number;           // liqPrice (USD) — the only bound that matters
  deviationPct: number;         // (eth - anchor) / anchor * 100, signed
                                //   positive = ETH rose (safer); negative = ETH dropped (closer to liq)
  thresholdPct: number;         // mode-specific drop tolerance (0.039 / 0.176 / 0.518)
  secondsElapsed: number;       // since startTime
  secondsRemaining: number;     // until endTime
  alertLevel: 'safe' | 'warn' | 'danger';  // green/yellow/red
}

export interface CorpStateBlock {
  wallet: string;
  count: number;
  lastUpdateTs: number;
  ok: boolean;
  error?: string;
  corps: CorpState[];
}

// Mode → operation-type label. Verified live by reading getTradeInfo on
// completed trades and observing endTime − startTime:
//   mode 0 → 5 min  → Extortion
//   mode 1 → 30 min → Arms Deal
//   mode 2 → 90 min → Drug Deal
// (When a corp shows mode 0 with active=false it's actually idle, not a
// running Extortion — handled in the renderer.)
const MODE_LABEL: Record<number, string> = {
  0: 'Extortion',  // also doubles as 'idle' when active=false; renderer disambiguates
  1: 'Arms Deal',
  2: 'Drug Deal',
};

const MODE_WINDOW_SEC: Record<number, number> = {
  0: 300,    // 5 min — Extortion
  1: 1800,   // 30 min — Arms
  2: 5400,   // 90 min — Drug
};

// Per-mode liquidation threshold (deviation % from anchor). Verified against
// `getTradeInfo()` word 3 (pre-computed lower bound) on all 6 active corps —
// matches to 4 decimals.
const MODE_LIQ_THRESHOLD: Record<number, number> = {
  0: 0.00039,  // Extortion 0.039%
  1: 0.00176,  // Arms 0.176%
  2: 0.00518,  // Drug 0.518%
};

// Headroom alert levels. Tunable; defaults below match the planned
// dashboard color coding (green / yellow / red).
const HEADROOM_WARN  = 50;  // below 50% → yellow
const HEADROOM_DANGER = 25;  // below 25% → red

/**
 * Compute live op headroom for a corp given the current ETH price (USD).
 * Returns null when the op is not active. Pure function — no side effects,
 * no IO. Called from the dashboard state assembler in volatility.getState().
 */
export function computeOpHeadroom(corp: CorpState, ethPrice: number | null): OpHeadroom | null {
  const ti = corp.tradeInfo;
  if (!ti || !ti.active) return null;
  if (ethPrice == null || !Number.isFinite(ethPrice) || ethPrice <= 0) return null;

  // entryPrice / liqPrice are 1e18-scaled raw bigint hex strings.
  const anchor1e18 = BigInt(ti.entryPrice || '0x0');
  const lower1e18  = BigInt(ti.liqPrice  || '0x0');
  if (anchor1e18 === 0n || lower1e18 === 0n) return null;

  const anchorPrice = Number(anchor1e18) / 1e18;
  const lowerBound  = Number(lower1e18) / 1e18;
  const fullBand    = anchorPrice - lowerBound;   // = anchorPrice × threshold
  if (fullBand <= 0) return null;

  // ONE-SIDED DOWN. Liquidation only fires when ETH drops below lowerBound
  // — ETH rising above the anchor is safe, full stop. The headroom is the
  // fraction of the band remaining (capped at 100% when ETH ≥ anchor; <0
  // when ETH has already dropped past the bound).
  const distAbove   = ethPrice - lowerBound;
  const headroomPct = Math.max(-100, Math.min(100, (distAbove / fullBand) * 100));

  const deviationPct = ((ethPrice - anchorPrice) / anchorPrice) * 100;
  const threshold = MODE_LIQ_THRESHOLD[ti.mode] ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);

  let alertLevel: OpHeadroom['alertLevel'] = 'safe';
  if (headroomPct < HEADROOM_DANGER) alertLevel = 'danger';
  else if (headroomPct < HEADROOM_WARN) alertLevel = 'warn';

  return {
    headroomPct,
    ethPrice,
    anchorPrice,
    lowerBound,
    deviationPct,
    thresholdPct: threshold * 100,
    secondsElapsed:   Math.max(0, nowSec - ti.startTime),
    secondsRemaining: Math.max(0, ti.endTime - nowSec),
    alertLevel,
  };
}

// LocationId → human-readable name. Pulled from the public Supabase
// locations table; only Caribbean / Europe / Indian Ocean tier (PL≤3)
// matter for now.
const LOCATION_LABEL: Record<number, string> = {
  0: 'Cayman Islands',
  1: 'British Virgin Islands',
  2: 'Bermuda',
  3: 'Malta',
  4: 'Cyprus',
  5: 'Andorra',
  6: 'Mauritius',
  7: 'Seychelles',
  8: 'UAE',
};

// --- Multicall3 ABI helpers (mirror of the ones in onchain-balances) ---

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

async function rpcCall<T = any>(method: string, params: any[]): Promise<T> {
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

function encodeBalanceOfStyleArg(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

export async function fetchUserCompanies(wallet: string): Promise<string[]> {
  const data = SEL.getUserCompanies + encodeBalanceOfStyleArg(wallet);
  const result = await rpcCall<string>('eth_call', [{ to: USER_FACTORY, data }, 'latest']);
  const h = result.replace(/^0x/, '');
  if (h.length < 128) return [];
  // address[]: offset(32) + length(32) + N*addresses
  const length = parseInt(h.substring(64, 128), 16);
  const addrs: string[] = [];
  for (let i = 0; i < length; i++) {
    const word = h.substring(128 + i * 64, 128 + (i + 1) * 64);
    addrs.push('0x' + word.slice(24));
  }
  return addrs;
}

/**
 * Module-level helper: read full per-corp state for a list of corps in one
 * multicall round-trip. Reused by both the operator's CorpStateFeed poll
 * and the public WalletTracker (Phase 2). Returns CorpState[] with
 * opHeadroom=null — caller enriches with live ETH price.
 */
export async function fetchCorpStatesFor(companies: string[]): Promise<CorpState[]> {
  if (companies.length === 0) return [];
  const now = Date.now();
  const calls: { target: string; allowFailure: boolean; callData: string }[] = [];
  for (const corp of companies) {
    for (const fn of PER_CORP_READS) {
      calls.push({ target: corp, allowFailure: true, callData: SEL[fn] });
    }
  }
  const data = encodeMulticall3Aggregate3(calls);
  const resultHex = await rpcCall<string>('eth_call', [{ to: MULTICALL3, data }, 'latest']);
  const decoded = decodeMulticall3Aggregate3(resultHex);

  const corps: CorpState[] = [];
  for (let i = 0; i < companies.length; i++) {
    const offset = i * PER_CORP_READS.length;
    const slice = decoded.slice(offset, offset + PER_CORP_READS.length);

    const reads: Record<SelKey, { success: boolean; data: string }> = {} as any;
    PER_CORP_READS.forEach((k, idx) => { reads[k] = slice[idx]; });

    const tradeInfo = reads.getTradeInfo.success ? decodeTradeInfo(reads.getTradeInfo.data) : null;
    const cooldownEnd = reads.getCooldownEnd.success ? Number(decodeUint256(reads.getCooldownEnd.data)) : 0;
    const cooldownRemain = cooldownEnd > 0 ? Math.max(0, cooldownEnd - Math.floor(now / 1000)) : 0;
    const pendingRewardRaw = reads.pendingReward.success ? decodeUint256(reads.pendingReward.data) : 0n;

    const isCompletable = reads.isCompletable.success ? decodeBool(reads.isCompletable.data) : false;
    const isLiquidatable = reads.isLiquidatable.success ? decodeBool(reads.isLiquidatable.data) : false;
    const hasPendingClaim = reads.hasPendingClaim.success ? decodeBool(reads.hasPendingClaim.data) : false;

    const status: CorpState['status'] =
      isLiquidatable ? 'liquidatable'
      : isCompletable || hasPendingClaim ? 'claimable'
      : tradeInfo?.active ? 'running'
      : reads.autoTradeEnabled.success && decodeBool(reads.autoTradeEnabled.data) ? 'idle'
      : 'idle';

    const mode = tradeInfo?.mode ?? (reads.autoTradeMode.success ? decodeUint8(reads.autoTradeMode.data) : 0);
    const locationId = reads.locationId.success ? decodeUint8(reads.locationId.data) : -1;
    const isIdle = !tradeInfo?.active && !hasPendingClaim && !isCompletable && !isLiquidatable;
    const modeLabelResolved = isIdle ? 'idle' : (MODE_LABEL[mode] ?? `mode ${mode}`);

    corps.push({
      address: companies[i],
      index: i,
      autoTradeEnabled: reads.autoTradeEnabled.success ? decodeBool(reads.autoTradeEnabled.data) : false,
      autoTradeMode: reads.autoTradeMode.success ? decodeUint8(reads.autoTradeMode.data) : 0,
      cooldownEnd,
      cooldownRemainSec: cooldownRemain,
      hasPendingClaim,
      isCompletable,
      isLiquidatable,
      pendingReward: Number(pendingRewardRaw) / 1e18,
      pendingRewardRaw: pendingRewardRaw.toString(),
      locationId,
      tradeInfo,
      opHeadroom: null,
      modeLabel: modeLabelResolved,
      locationLabel: LOCATION_LABEL[locationId] ?? `loc ${locationId}`,
      status,
      ok: slice.every(s => s.success),
    });
  }
  return corps;
}

function decodeUint256(hex: string): bigint { return BigInt(hex || '0x0'); }
function decodeBool(hex: string): boolean { return BigInt(hex || '0x0') !== 0n; }
function decodeUint8(hex: string): number { return Number(BigInt(hex || '0x0')); }

interface RawTradeInfo {
  active: boolean;
  mode: number;
  entryPrice: string;
  liqPrice: string;
  startTime: number;
  endTime: number;
  influence: string;
  pending: string;
}

function decodeTradeInfo(hex: string): RawTradeInfo | null {
  const h = (hex || '').replace(/^0x/, '');
  if (h.length < 64 * 8) return null;
  return {
    active:    parseInt(h.substring(0, 64), 16) === 1,
    mode:      parseInt(h.substring(64, 128), 16),
    entryPrice: '0x' + h.substring(128, 192),
    liqPrice:   '0x' + h.substring(192, 256),
    startTime: Number(BigInt('0x' + h.substring(256, 320))),
    endTime:   Number(BigInt('0x' + h.substring(320, 384))),
    influence: '0x' + h.substring(384, 448),
    pending:   '0x' + h.substring(448, 512),
  };
}

export class CorpStateFeed extends EventEmitter {
  private wallet: string | null;
  private companies: string[] = [];
  private companyListInterval: ReturnType<typeof setInterval> | null = null;
  private statePollInterval: ReturnType<typeof setInterval> | null = null;
  private alive = false;
  private pollMs: number;

  constructor(wallet: string | null, pollMs = CORP_STATE_POLL_MS_DEFAULT) {
    super();
    this.wallet = wallet && wallet.length === 42 ? wallet : null;
    this.pollMs = pollMs;
  }

  get connected() { return this.alive; }

  async start() {
    if (!this.wallet) {
      logger.info('[CorpState] No WALLET_ADDRESS configured; feed disabled.');
      return;
    }
    await this.refreshCompanyList();
    this.companyListInterval = setInterval(() => { void this.refreshCompanyList(); }, COMPANY_LIST_POLL_MS);
    void this.pollAllStates();
    this.statePollInterval = setInterval(() => { void this.pollAllStates(); }, this.pollMs);
  }

  stop() {
    if (this.companyListInterval) clearInterval(this.companyListInterval);
    if (this.statePollInterval) clearInterval(this.statePollInterval);
    this.alive = false;
  }

  private async refreshCompanyList() {
    if (!this.wallet) return;
    try {
      const list = await fetchUserCompanies(this.wallet);
      const changed = list.length !== this.companies.length ||
                      list.some((a, i) => a !== this.companies[i]);
      this.companies = list;
      if (changed) {
        logger.info({ count: list.length }, '[CorpState] Company list refreshed');
        // Trigger immediate state poll on list change.
        void this.pollAllStates();
      }
    } catch (err: any) {
      logger.error({ err: err.message }, '[CorpState] refreshCompanyList failed');
    }
  }

  private async pollAllStates() {
    if (!this.wallet || this.companies.length === 0) return;
    const now = Date.now();
    try {
      const corps = await fetchCorpStatesFor(this.companies);
      this.alive = true;
      this.emit('status', true);
      this.emit('corps', {
        wallet: this.wallet,
        count: corps.length,
        lastUpdateTs: now,
        ok: true,
        corps,
      } as CorpStateBlock);
    } catch (err: any) {
      this.alive = false;
      this.emit('status', false);
      this.emit('corps', {
        wallet: this.wallet,
        count: this.companies.length,
        lastUpdateTs: now,
        ok: false,
        error: err.message,
        corps: [],
      } as CorpStateBlock);
      logger.error({ err: err.message }, '[CorpState] pollAllStates failed');
    }
  }
}
