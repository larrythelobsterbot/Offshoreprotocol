import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import path from 'path';
import { timingSafeEqual } from 'crypto';
import type { WebSocket } from 'ws';
import type { DashboardState } from '../types';
// (config used at runtime to gate operator-only endpoints in PUBLIC_MODE)
import { Storage } from '../storage/db';
import { config } from '../config';
import { logger } from '../logger';
import type { WalletTracker } from '../feeds/wallet-tracker';
import { walletLogTag } from '../feeds/wallet-tracker';
import type { ScheduleEvidenceFeed } from '../feeds/schedule-evidence';
import type { DirtyFlowFeed } from '../feeds/dirty-flow';
import type { NetworkOpsFeed } from '../feeds/network-ops';
import { computeEfficiency, computeScheduleAudit } from '../engine/efficiency';
import { jsonSafeInfinity } from '../utils/json-safe';
import {
  optimizeLoadouts,
  ASSET_TYPES,
  type AssetType,
  type OptimizerItem,
} from '../engine/loadout-optimizer';
import {
  simulateLoadout,
  deriveGeneratorBase,
  STATUS_BASE_ST,
  STATUS_CLEANING_BONUS_PCT,
  type GeneratorBase,
} from '../engine/loadout-simulator';

// --- Public-safe state picker (FlowDirty.fun) ---
// Strips operator-private fields from DashboardState before broadcasting on
// the public /ws/network endpoint or returning from /api/network/state.
// Defense in depth: the nginx vhost for flowdirty.fun also whitelists paths,
// so even a bug here can't surface walletBalances on the public domain.
function pickPublicState(state: DashboardState): any {
  if (!state) return null;
  // Strip the operator's user-side loadouts; keep network-wide loadout meta
  // (top equipped assets, leaderboard) which is just chain-aggregated stats.
  const loadouts = state.loadouts
    ? {
        user: null,                 // operator's own loadouts removed
        network: state.loadouts.network ?? null,
        topPlayers: state.loadouts.topPlayers ?? [],
        templatesAvailable: state.loadouts.templatesAvailable ?? 0,
        cycle: state.loadouts.cycle ?? null,
      }
    : null;

  // Current per-op INF stake. Floats with $DIRTY price. Two sources, in
  // order of preference:
  //   1. OpParamsFeed.infCostPerOp — network-wide median across all active
  //      trades (works even when operator has no active corps).
  //   2. Operator's own active corp's tradeInfo.influence (legacy fallback).
  // The feed approach is more robust on FlowDirty's public surface; the
  // fallback handles edge cases where the feed hasn't completed first poll.
  let opCostInf: number | null = null;
  try {
    const feedCost = (state as any).opParams?.infCostPerOp;
    if (typeof feedCost === 'number' && Number.isFinite(feedCost) && feedCost > 0) {
      opCostInf = feedCost;
    } else {
      const corps = (state as any).corpState?.corps;
      if (Array.isArray(corps)) {
        const active = corps.find((c: any) => c?.tradeInfo?.active && c?.tradeInfo?.influence);
        if (active) {
          opCostInf = Number(BigInt(active.tradeInfo.influence)) / 1e18;
        }
      }
    }
  } catch { /* swallow */ }

  return {
    publicMode: true,
    ethPrice: state.ethPrice,
    ethPriceStart: state.ethPriceStart,
    volatility: state.volatility,
    scores: state.scores,
    economics: state.economics,
    opStats: state.opStats,
    ammRate: state.ammRate,
    dirtyPrice: state.dirtyPrice,
    loadouts,
    tokenomics: state.tokenomics,
    activity: state.activity,
    orderbook: (state as any).orderbook,
    cvd: (state as any).cvd,
    hyperliquid: (state as any).hyperliquid,
    heatmap: (state as any).heatmap,
    liquidations: (state as any).liquidations,
    alerts: (state as any).alerts,
    connections: (state as any).connections,
    meta: (state as any).meta,
    calibration: (state as any).calibration,
    opCostInf,                     // current INF stake per op (FlowDirty topbar)
    // RedStone price + divergence vs HL is chain-derived and bot-agnostic
    // → public-safe. Shadow danger is operator-derived (uses internal
    // signals), so we strip it before publishing.
    redstone: (state as any).redstone
      ? { ...(state as any).redstone, shadow: null }
      : null,
    // Live liquidation thresholds + weekend mode flag — public-safe (chain-derived)
    opParams: (state as any).opParams ?? null,
    // EXPLICITLY OMITTED — never reach the public stream:
    //   walletBalances, corpState, loadouts.user
  };
}

// --- Deep diff utility for delta-based WS updates ---

function deepDiff(prev: any, next: any): any | null {
  if (prev === next) return null;
  if (prev === null || next === null || typeof prev !== typeof next) return next;
  if (typeof next !== 'object') return next;

  if (Array.isArray(next)) {
    if (!Array.isArray(prev) || prev.length !== next.length) return next;
    // For arrays, check if content changed; if so send the whole array
    for (let i = 0; i < next.length; i++) {
      if (deepDiff(prev[i], next[i]) !== null) return next;
    }
    return null;
  }

  const diff: any = {};
  let hasChanges = false;

  // Check all keys in next
  for (const key of Object.keys(next)) {
    const d = deepDiff(prev[key], next[key]);
    if (d !== null) {
      diff[key] = d;
      hasChanges = true;
    }
  }

  // Check for removed keys
  for (const key of Object.keys(prev)) {
    if (!(key in next)) {
      diff[key] = null;
      hasChanges = true;
    }
  }

  return hasChanges ? diff : null;
}

export class ApiServer {
  private app = Fastify({
    // PRIVACY: disable auto request logging entirely. Fastify's default
    // "incoming request" / "request completed" lines include req.url,
    // which on /api/track/<wallet> contains the user's address. We use
    // explicit, redacted logging in the handler instead. See the
    // wallet-tracker handler below for the privacy-safe call.
    disableRequestLogging: true,
    logger: {
      level: config.logLevel,
      // Defense in depth: even if a downstream caller passes req.url
      // into a log line, redact the wallet portion in pino's serializer.
      serializers: {
        req(req: any) {
          const url = typeof req.url === 'string'
            ? req.url.replace(/\/api\/track\/0x[0-9a-fA-F]{40}/g, '/api/track/[redacted]')
            : req.url;
          return { method: req.method, url, host: req.headers?.host };
        },
      },
      ...(process.env.NODE_ENV !== 'production' && {
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
      }),
    },
  });
  private clients = new Set<WebSocket>();
  private clientPrevState = new Map<WebSocket, DashboardState>();
  // FlowDirty.fun public WS subscribers — receive only the public-safe slice
  // (no walletBalances, no corpState, no operator's loadouts.user, no bot).
  private publicClients = new Set<WebSocket>();
  private publicClientPrevState = new Map<WebSocket, any>();
  private storage: Storage;
  private getState: () => DashboardState;
  private onOpStatsChanged?: () => void;
  private walletTracker?: WalletTracker;
  private scheduleEvidence?: ScheduleEvidenceFeed;
  private dirtyFlow?: DirtyFlowFeed;
  // Schedule accessor — passed in as a function (rather than a CorpBot
  // reference) so the schedule auditor can read the live 24-element
  // array without coupling the API server to the trading bot.
  private getSchedule?: () => string[];
  private networkOps?: NetworkOpsFeed;

  constructor(
    storage: Storage,
    getState: () => DashboardState,
    onOpStatsChanged?: () => void,
    walletTracker?: WalletTracker,
    scheduleEvidence?: ScheduleEvidenceFeed,
    dirtyFlow?: DirtyFlowFeed,
    getSchedule?: () => string[],
    networkOps?: NetworkOpsFeed,
  ) {
    this.storage = storage;
    this.getState = getState;
    this.onOpStatsChanged = onOpStatsChanged;
    this.walletTracker = walletTracker;
    this.scheduleEvidence = scheduleEvidence;
    this.dirtyFlow = dirtyFlow;
    this.getSchedule = getSchedule;
    this.networkOps = networkOps;
  }

  async start() {
    // Plugins
    // CORS: allow same-origin (no Origin header) + explicit allow list.
    // Defaults: localhost dev ports + the operator's public dashboard URL.
    // Include both http:// and https:// variants of the dashboard URL — nginx
    // may terminate at either, and the browser's Origin header reflects the
    // scheme it actually loaded the page over.
    const dashboardVariants: string[] = [];
    if (config.dashboardUrl) {
      dashboardVariants.push(config.dashboardUrl);
      if (config.dashboardUrl.startsWith('https://')) {
        dashboardVariants.push('http://' + config.dashboardUrl.slice(8));
      } else if (config.dashboardUrl.startsWith('http://')) {
        dashboardVariants.push('https://' + config.dashboardUrl.slice(7));
      }
    }
    const defaultOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3456',
      'http://127.0.0.1:3456',
      // FlowDirty.fun — public landing/terminal/tracker. CF proxied, both
      // schemes allowed (CF strips http→https but origin header may vary).
      'https://flowdirty.fun',
      'http://flowdirty.fun',
      'https://www.flowdirty.fun',
      'http://www.flowdirty.fun',
      ...dashboardVariants,
    ].filter(Boolean);
    const extraOrigins = config.corsOrigins
      ? config.corsOrigins.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const allowedOrigins = new Set([...defaultOrigins, ...extraOrigins]);
    await this.app.register(fastifyCors, {
      origin: (origin, cb) => {
        // No Origin header = same-origin or non-browser (curl, server-side); allow.
        if (!origin) return cb(null, true);
        if (allowedOrigins.has(origin)) return cb(null, true);
        return cb(new Error('CORS: origin not allowed'), false);
      },
      credentials: false,
    });
    await this.app.register(fastifyWebsocket);
    await this.app.register(fastifyStatic, {
      root: path.join(process.cwd(), 'public'),
      prefix: '/',
    });

    // --- WebSocket endpoints ---
    // /ws         — full operator state (private dashboard)
    // /ws/network — public-safe slice (FlowDirty.fun terminal page)
    this.app.register(async (app) => {
      app.get('/ws', { websocket: true }, (socket, _req) => {
        this.clients.add(socket);
        logger.info({ clientCount: this.clients.size }, '[WS] Client connected');

        // Send full initial state
        try {
          const state = this.getState();
          socket.send(JSON.stringify({ type: 'state', full: true, data: state }));
          this.clientPrevState.set(socket, structuredClone(state));
        } catch {}

        socket.on('close', () => {
          this.clients.delete(socket);
          this.clientPrevState.delete(socket);
          logger.info({ clientCount: this.clients.size }, '[WS] Client disconnected');
        });

        socket.on('error', () => {
          this.clients.delete(socket);
          this.clientPrevState.delete(socket);
        });
      });

      app.get('/ws/network', { websocket: true }, (socket, _req) => {
        this.publicClients.add(socket);
        logger.info({ clientCount: this.publicClients.size }, '[WS-PUBLIC] Client connected');
        try {
          const state = pickPublicState(this.getState());
          socket.send(JSON.stringify({ type: 'state', full: true, data: state }));
          this.publicClientPrevState.set(socket, structuredClone(state));
        } catch {}
        socket.on('close', () => {
          this.publicClients.delete(socket);
          this.publicClientPrevState.delete(socket);
          logger.info({ clientCount: this.publicClients.size }, '[WS-PUBLIC] Client disconnected');
        });
        socket.on('error', () => {
          this.publicClients.delete(socket);
          this.publicClientPrevState.delete(socket);
        });
      });
    });

    // --- REST endpoints ---

    // Current state snapshot
    this.app.get('/api/state', async () => {
      return this.getState();
    });

    // Public-safe REST snapshot — what FlowDirty.fun's terminal page uses on
    // first load before the WS subscription kicks in. Stripped of operator's
    // wallet, corps, bot, and private loadout fields.
    this.app.get('/api/network/state', async (_req, reply) => {
      reply.header('Cache-Control', 'public, max-age=2, s-maxage=4');
      return pickPublicState(this.getState());
    });

    // Historical indicators (Improvement 7: schema validation)
    this.app.get<{ Querystring: { since?: string; from?: string; to?: string } }>(
      '/api/indicators',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              since: { type: 'integer', minimum: 1 },
              from: { type: 'integer', minimum: 1 },
              to: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
      async (req, reply) => {
        const { since, from, to } = req.query;
        if (from !== undefined && to !== undefined) {
          if (Number(from) >= Number(to)) {
            return reply.status(400).send({ error: 'Bad Request', message: '`from` must be less than `to`' });
          }
          return this.storage.getIndicatorsRange(Number(from), Number(to));
        }
        const sinceMs = since ? Number(since) : Date.now() - 3600_000;
        return this.storage.getIndicatorsSince(sinceMs);
      }
    );

    // Recent alerts (Improvement 7: schema validation)
    this.app.get<{ Querystring: { since?: string } }>(
      '/api/alerts',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              since: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
      async (req) => {
        const sinceMs = req.query.since ? Number(req.query.since) : Date.now() - 86400_000;
        return this.storage.getAlertsSince(sinceMs);
      }
    );

    // DB stats
    this.app.get('/api/stats', async () => {
      return this.storage.getStats();
    });

    // --- Op outcome logging (used by partial-fraction tracker) ---
    // In PUBLIC_MODE these endpoints are gated — they're for the operator
    // only. Multi-tenant equivalents live behind the Telegram bot.
    const publicGate = (handler: any) => async (req: any, reply: any) => {
      if (config.publicMode) {
        return reply.status(404).send({ error: 'Not Found' });
      }
      return handler(req, reply);
    };

    // Operator gate for mutating endpoints (POST/DELETE /api/op-result).
    // Loopback hosts (127.0.0.1, ::1) are trusted without a token (operator dev).
    // Non-loopback binds REQUIRE OPERATOR_API_TOKEN and a matching
    // `Authorization: Bearer <token>` (or `?token=<token>`) on every request.
    const isLoopbackHost = config.host === '127.0.0.1' || config.host === '::1' || config.host === 'localhost';
    if (!isLoopbackHost && !config.operatorApiToken && !config.publicMode) {
      logger.warn(
        { host: config.host },
        '[API] Non-loopback host without OPERATOR_API_TOKEN — mutating endpoints will be REJECTED. Set OPERATOR_API_TOKEN in .env or bind HOST=127.0.0.1.',
      );
    }
    const operatorGate = (handler: any) => async (req: any, reply: any) => {
      if (isLoopbackHost && !config.operatorApiToken) {
        // Loopback dev: allow without token.
        return handler(req, reply);
      }
      if (!config.operatorApiToken) {
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'OPERATOR_API_TOKEN not configured; mutating endpoints disabled.',
        });
      }
      const auth = (req.headers.authorization || '') as string;
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const queryToken = (req.query?.token || '') as string;
      const provided = bearer || queryToken;
      // Constant-time comparison to avoid timing leaks on the token.
      const a = Buffer.from(provided);
      const b = Buffer.from(config.operatorApiToken);
      const ok = a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
      if (!ok) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      return handler(req, reply);
    };

    // Log a single op outcome. The user (or a future scraper) POSTs this
    // when an operation completes in-game. baseReward defaults to PL1=100
    // if not provided; pass it explicitly when the player has leveled up.
    this.app.post<{
      Body: {
        opType: 'extortion' | 'arms' | 'drug';
        succeeded: boolean;
        dirtyEarned: number;
        baseReward?: number;
        ts?: number;
        note?: string;
      };
    }>(
      '/api/op-result',
      {
        schema: {
          body: {
            type: 'object',
            required: ['opType', 'succeeded', 'dirtyEarned'],
            properties: {
              opType: { type: 'string', enum: ['extortion', 'arms', 'drug'] },
              succeeded: { type: 'boolean' },
              dirtyEarned: { type: 'number', minimum: 0, maximum: 10000 },
              baseReward: { type: 'number', minimum: 1, maximum: 1000 },
              ts: { type: 'integer', minimum: 1 },
              note: { type: 'string', maxLength: 500 },
            },
            additionalProperties: false,
          },
        },
      },
      publicGate(operatorGate(async (req: any, reply: any) => {
        const { opType, succeeded, dirtyEarned, baseReward, ts, note } = req.body;
        // Sanity: dirtyEarned should not exceed reasonable cap of base; clamp.
        const base = baseReward ?? 100;
        if (dirtyEarned > base * 2) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: `dirtyEarned (${dirtyEarned}) exceeds 2x base reward (${base}). Likely a typo.`,
          });
        }
        // Manual op-result inserts MUST carry an inf_cost so DIRTY/INF
        // aggregations stay correct. Default to the latest op-params
        // snapshot (~9-12 INF live) so pasted outcomes don't get NULL
        // cost and silently overstate efficiency. If the feed hasn't
        // sampled yet, fall back to historical 5.0.
        const latestParams = this.storage.getLatestOpParams();
        const fallbackInfCost = (() => {
          const all = [latestParams[0], latestParams[1], latestParams[2]]
            .filter(p => p?.inf_cost_per_op != null)
            .sort((a, b) => (b!.ts ?? 0) - (a!.ts ?? 0));
          return all[0]?.inf_cost_per_op ?? 5.0;
        })();
        const id = this.storage.insertOpOutcome({
          ts: ts ?? Date.now(),
          opType,
          succeeded: succeeded ? 1 : 0,
          dirtyEarned,
          baseReward: base,
          note,
          // infCost auto-derives infBurned in insertOpOutcome
          // (succeeded → 0, failed → infCost).
          infCost: fallbackInfCost,
        });
        this.onOpStatsChanged?.();
        return { success: true, id };
      })),
    );

    // Read aggregated stats per op type. The dashboard's op cards consume
    // this via the WebSocket DashboardState.opStats, but exposing as REST
    // is useful for debugging and for any downstream tooling.
    this.app.get('/api/op-stats', publicGate(async () => {
      return this.getState().opStats;
    }));

    // Time-windowed activity rollup (last hour, last 24h, since session start).
    // Mirrors the in-game Activity Log's structure.
    this.app.get('/api/op-summary', publicGate(async () => {
      return (this.getState() as any).activity;
    }));

    // Schedule evidence — rolling 7-day network-wide hourly stats with
    // best/worst hours per op type. Operator-only (gated by publicGate).
    // The dashboard's "Schedule Evidence" panel reads from here.
    this.app.get<{ Querystring: { days?: string; sinceLeverageMs?: string; regime?: 'all' | 'weekday' | 'weekend' | 'split' } }>(
      '/api/schedule-evidence',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              days: { type: 'integer', minimum: 1, maximum: 30 },
              // Cutoff timestamp. Rows older than this are excluded from
              // the rolling sample (used to invalidate pre-leverage-v2 data).
              sinceLeverageMs: { type: 'integer', minimum: 0 },
              // 'split' returns { all, weekday, weekend } — the dashboard
              // uses this to show weekday/weekend tables separately so
              // weekend leverage doesn't bias the weekday model.
              regime: { type: 'string', enum: ['all', 'weekday', 'weekend', 'split'] },
            },
          },
        },
      },
      publicGate(async (req: any) => {
        if (!this.scheduleEvidence) return { error: 'Not configured' };
        const days = req.query?.days ? Number(req.query.days) : 7;
        const cutoff = req.query?.sinceLeverageMs ? Number(req.query.sinceLeverageMs) : undefined;
        const regime = req.query?.regime ?? 'all';
        if (regime === 'split') {
          return this.scheduleEvidence.getRollingStatsByRegime(days, cutoff);
        }
        // Single-regime call still routes through the same regime-aware
        // computation; default 'all' preserves backward compat.
        const split = this.scheduleEvidence.getRollingStatsByRegime(days, cutoff);
        return split[regime as 'all' | 'weekday' | 'weekend'] ?? split.all;
      }),
    );

    // Strategy attribution — per-strategy SR + DIRTY/INF over a window.
    // The dashboard's STRATEGY ATTRIBUTION panel uses this to answer
    // "which decision path is actually paying off?". Operator-only.
    this.app.get<{ Querystring: { hours?: string } }>(
      '/api/strategy-attribution',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              hours: { type: 'integer', minimum: 1, maximum: 720 },  // up to 30d
            },
          },
        },
      },
      publicGate(async (req: any) => {
        const hours = req.query?.hours ? Number(req.query.hours) : 168;  // 7d default
        const sinceMs = Date.now() - hours * 3600_000;
        const rows = this.storage.getStrategyAttribution(sinceMs);
        // Compute baseline (all strategies combined) so the UI can show
        // "how does this strategy compare to overall?". Useful sanity
        // check before retiring underperformers.
        const totals = rows.reduce(
          (acc, r) => ({
            ops:         acc.ops + r.ops,
            wins:        acc.wins + r.wins,
            dirtyEarned: acc.dirtyEarned + r.dirtyEarned,
            infBurned:   acc.infBurned + r.infBurned,
          }),
          { ops: 0, wins: 0, dirtyEarned: 0, infBurned: 0 },
        );
        // Baseline DPI is Infinity when all strategies had zero failures
        // (every op succeeded → INF refunded → no INF spent).
        const baselineDpi = totals.infBurned > 0
          ? totals.dirtyEarned / totals.infBurned
          : (totals.wins > 0 ? Infinity : null);
        // jsonSafeInfinity preserves Infinity as the sentinel string
        // 'Infinity' so the dashboard can render ∞ instead of seeing null.
        return jsonSafeInfinity({
          windowHours: hours,
          generatedAt: Date.now(),
          rows,
          baseline: {
            ops: totals.ops,
            successRate: totals.ops > 0 ? totals.wins / totals.ops : 0,
            dirtyEarned: totals.dirtyEarned,
            infBurned:   totals.infBurned,
            dirtyPerInf: baselineDpi,
          },
        });
      }),
    );

    // THRESHOLD-CLIFF — operator-only calibration tile. Surfaces the live
    // gate state + 7d shadow-mode stats so the operator can eyeball
    // precision before flipping THRESHOLD_CLIFF_SHADOW=false. Pending
    // would-blocks (op still in-flight) are excluded from the precision
    // denominator; only resolved outcomes count.
    this.app.get<{ Querystring: { days?: string } }>(
      '/api/threshold-cliff',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              days: { type: 'integer', minimum: 1, maximum: 90 },
            },
          },
        },
      },
      publicGate(async (req: any) => {
        const days = req.query?.days ? Number(req.query.days) : 7;
        const sinceMs = Date.now() - days * 86400_000;
        const stats = this.storage.getThresholdCliffShadowStats(sinceMs);
        // Live gate state is on the broadcast state object (thresholdCliffGate
        // is attached in src/index.ts getState wrapper). Read it once at
        // request time so the tile reflects this-tick reality.
        const live = (this.getState() as any).thresholdCliffGate ?? null;
        return jsonSafeInfinity({
          windowDays: days,
          generatedAt: Date.now(),
          live,
          stats,
        });
      }),
    );

    // BURN-VS-CLAIM — operator-only economics tile. Pairs each whale_claims
    // row (operator's USDm claims) with the INF burned in the 8h pre-claim
    // window so we can see "are vault claims actually covering my INF
    // spend?". Aggregate computes daily/weekly run rates from first to
    // last claim. INF/USDm is 1:1 peg so window_inf_burned == cost_usdm.
    this.app.get<{ Querystring: { days?: string } }>(
      '/api/burn-vs-claim',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              days: { type: 'integer', minimum: 1, maximum: 90 },
            },
          },
        },
      },
      publicGate(async (req: any) => {
        const days = req.query?.days ? Number(req.query.days) : 14;
        const result = this.storage.getOperatorBurnVsClaim({
          operator: config.walletAddress,
          days,
        });
        return jsonSafeInfinity({
          windowDays: days,
          generatedAt: Date.now(),
          ...result,
        });
      }),
    );

    // DIRTY HEALTH — token flow rollup (mints, burns, sells, buys) over
    // 24h + 7d windows with trend deltas. The dashboard tile uses this
    // to surface buy-or-sell-DIRTY decision context.
    this.app.get(
      '/api/dirty-health',
      publicGate(async () => {
        if (!this.dirtyFlow) return { error: 'Not configured' };
        return this.dirtyFlow.getHealthSnapshot();
      }),
    );

    // INF EFFICIENCY — DIRTY-per-INF rollups over a window, broken down
    // by hour, op_type, and (sparsely) strategy. The headline metric is
    // dirty_per_inf, which captures both successes AND partial payouts
    // from failed ops — the SR-only view misses progressive payouts on
    // Drug/Arms liquidations and overstates Drug's apparent dominance.
    this.app.get<{ Querystring: { hours?: string; regime?: 'all' | 'weekday' | 'weekend' | 'split' } }>(
      '/api/efficiency',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              hours: { type: 'integer', minimum: 1, maximum: 720 },
              regime: { type: 'string', enum: ['all', 'weekday', 'weekend', 'split'] },
            },
          },
        },
      },
      publicGate(async (req: any) => {
        const hours = req.query?.hours ? Number(req.query.hours) : 24;
        const regime = (req.query?.regime ?? 'all') as 'all' | 'weekday' | 'weekend' | 'split';
        const operator = computeEfficiency(this.storage, { windowHours: hours, regime });
        // Inject the network-wide snapshot so the dashboard can show
        // "your DIRTY/INF vs network DIRTY/INF" per op_type/hour.
        // Network DIRTY/INF computed at API time using the live INF
        // cost from the latest op_params snapshot (so it stays current
        // as the contract recalibrates leverage).
        const network = this.networkOps?.getSnapshot(hours) ?? null;
        // Read latest INF cost — it floats with $DIRTY price, so a
        // cached value in NetworkOpsFeed would go stale fast.
        const latestParams = this.storage.getLatestOpParams();
        // op_params row ts is in ms; we want the most recent inf_cost across all 3 modes
        const infCostPerOp = (() => {
          const all = [latestParams[0], latestParams[1], latestParams[2]]
            .filter(p => p?.inf_cost_per_op != null)
            .sort((a, b) => (b!.ts ?? 0) - (a!.ts ?? 0));
          return all[0]?.inf_cost_per_op ?? 5.0;
        })();
        // Refund-on-success means dirty_per_inf can be Infinity. JSON
        // serialization would convert it to null silently — wrap the
        // response so Infinity becomes the sentinel string 'Infinity'
        // and the dashboard renders ∞ correctly.
        return jsonSafeInfinity({ ...operator, network, infCostPerOp });
      }),
    );

    // SCHEDULE AUDIT — for each (HKT hour, regime) slot in the current
    // schedule, compares actual DIRTY/INF against the all-Drug baseline
    // for the same hour+regime. Flags slots underperforming Drug by
    // >10% with sample size ≥ 5 ops. Default 7-day window.
    this.app.get<{ Querystring: { days?: string } }>(
      '/api/schedule-audit',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              days: { type: 'integer', minimum: 1, maximum: 30 },
            },
          },
        },
      },
      publicGate(async (req: any) => {
        if (!this.getSchedule) return { error: 'schedule accessor not configured' };
        const days = req.query?.days ? Number(req.query.days) : 7;
        // Wrap to preserve Infinity values across JSON.stringify (see
        // jsonSafeInfinity for the sentinel-string strategy).
        return jsonSafeInfinity(
          computeScheduleAudit(this.storage, this.getSchedule(), {
            windowHours: days * 24,
          }),
        );
      }),
    );

    // List recent outcomes (for verification / undo UI).
    this.app.get<{ Querystring: { limit?: string; opType?: 'extortion' | 'arms' | 'drug' } }>(
      '/api/op-results',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 1000 },
              opType: { type: 'string', enum: ['extortion', 'arms', 'drug'] },
            },
          },
        },
      },
      publicGate(async (req: any) => {
        const limit = req.query.limit ? Number(req.query.limit) : 50;
        return this.storage.getOpOutcomes({ opType: req.query.opType, limit });
      }),
    );

    // Undo a mistakenly logged outcome.
    this.app.delete<{ Params: { id: string } }>(
      '/api/op-result/:id',
      publicGate(operatorGate(async (req: any, reply: any) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id < 1) {
          return reply.status(400).send({ error: 'Bad Request', message: 'Invalid id' });
        }
        const deleted = this.storage.deleteOpOutcome(id);
        if (!deleted) return reply.status(404).send({ error: 'Not Found' });
        this.onOpStatsChanged?.();
        return { success: true };
      })),
    );

    // ── PUBLIC TRACKER (Phase 2) ──────────────────────────────────────
    // GET /api/track/:wallet — multi-tenant per-wallet snapshot used by
    // FlowDirty.fun and any other public consumer. Read-only, all data
    // is derived from public on-chain state, no operator-private fields.
    //
    // Rate limit: token bucket per IP. Distinct-wallet cap stops one IP
    // from sweeping arbitrary addresses to scrape the network. The
    // wallet-tracker has its own 30s cache so cache hits don't even hit
    // the limiter's RPC budget.
    //
    // PRIVACY: we store HASHED wallet tags (sha256 prefix) instead of raw
    // addresses. The cap behavior is identical (same number of distinct
    // hashes ↔ distinct wallets) but the IP→wallet join can't be
    // reconstructed even if a memory dump leaked. Buckets evict after
    // ~2min anyway, so this is a defense-in-depth move.
    if (this.walletTracker) {
      const RL_WINDOW_MS = 60_000;
      const RL_MAX_REQ_PER_WINDOW = 60;
      const RL_MAX_DISTINCT_WALLETS = 10;
      type Bucket = { count: number; windowStart: number; walletTags: Set<string> };
      const buckets = new Map<string, Bucket>();

      const rateLimited = (req: any, walletTag: string): { ok: boolean; retryAfter?: number } => {
        // SECURITY: prefer X-Real-IP (set by nginx from $remote_addr,
        // which is rewritten from CF-Connecting-IP via set_real_ip_from).
        // X-Forwarded-For is client-controllable on direct origin hits
        // and on any path that bypasses CF, so it's an unreliable bucket
        // key. Fall back to XFF (first hop only) and finally req.ip.
        const xri = (req.headers['x-real-ip'] || '').toString().trim();
        const xff = (req.headers['x-forwarded-for'] || '').toString().split(',')[0]?.trim();
        const ip = xri || xff || req.ip || 'unknown';
        const now = Date.now();
        let b = buckets.get(ip);
        if (!b || now - b.windowStart > RL_WINDOW_MS) {
          b = { count: 0, windowStart: now, walletTags: new Set() };
          buckets.set(ip, b);
        }
        if (b.count >= RL_MAX_REQ_PER_WINDOW) {
          const retryAfter = Math.ceil((RL_WINDOW_MS - (now - b.windowStart)) / 1000);
          return { ok: false, retryAfter };
        }
        // Distinct-wallet cap is checked AFTER req-count so a flood from
        // one IP can't ingest 60 unique wallets in a window. We compare
        // hashed tags, not addresses, so the limiter never holds raw
        // wallet/IP pairs in RAM.
        if (!b.walletTags.has(walletTag) && b.walletTags.size >= RL_MAX_DISTINCT_WALLETS) {
          return { ok: false, retryAfter: Math.ceil((RL_WINDOW_MS - (now - b.windowStart)) / 1000) };
        }
        b.count++;
        b.walletTags.add(walletTag);
        return { ok: true };
      };

      // Periodic GC of expired buckets (every 5 min) so the map doesn't
      // grow unbounded on a public-facing endpoint.
      setInterval(() => {
        const cutoff = Date.now() - RL_WINDOW_MS * 2;
        for (const [ip, b] of buckets) {
          if (b.windowStart < cutoff) buckets.delete(ip);
        }
      }, 5 * 60_000).unref();

      this.app.get<{ Params: { wallet: string } }>(
        '/api/track/:wallet',
        {
          schema: {
            params: {
              type: 'object',
              properties: {
                wallet: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
              },
              required: ['wallet'],
            },
          },
        },
        async (req, reply) => {
          const wallet = req.params.wallet.toLowerCase();
          const tag = walletLogTag(wallet);
          const limit = rateLimited(req, tag);
          if (!limit.ok) {
            return reply
              .status(429)
              .header('Retry-After', String(limit.retryAfter ?? 60))
              .send({ error: 'Too Many Requests', retryAfterSec: limit.retryAfter });
          }
          try {
            const result = await this.walletTracker!.track(wallet);
            // Aggressive cache headers — paired with our 30s in-memory cache,
            // a CDN edge could cache for ~30s safely.
            reply.header('Cache-Control', 'public, max-age=15, s-maxage=30');
            return result;
          } catch (err: any) {
            // Privacy: log only the hashed tag, never the raw wallet.
            logger.warn({ err: err.message, walletTag: tag }, '[track] fetch failed');
            return reply.status(503).send({ error: 'Service Unavailable', message: 'Chain read failed; please retry shortly.' });
          }
        },
      );

      // Companion endpoint: stats about the tracker itself (cache size,
      // distinct buckets). Useful for debug and the marketing footer
      // ("currently tracking N wallets across M visitors").
      this.app.get('/api/track-stats', async () => {
        return {
          cachedWallets: this.walletTracker!.size(),
          distinctIps: buckets.size,
        };
      });
    }

    // ── ORACLE DIVERGENCE ────────────────────────────────────────────
    // Time-series of RedStone (game's enforcement oracle) vs Hyperliquid
    // (bot's tick source) for the MARKET-tab Oracle Divergence panel.
    // Operator-only — divergence patterns reveal bot internals.
    this.app.get<{ Querystring: { hours?: string; limit?: string } }>(
      '/api/oracle-divergence',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              hours: { type: 'integer', minimum: 1, maximum: 720 },
              limit: { type: 'integer', minimum: 1, maximum: 5000 },
            },
          },
        },
      },
      publicGate(async (req: any) => {
        const hours = req.query?.hours ? Number(req.query.hours) : 2;
        const limit = req.query?.limit ? Number(req.query.limit) : 500;
        const sinceMs = Date.now() - hours * 3600_000;
        const history = this.storage.getOracleDivergence({ sinceMs, limit });
        const stats   = this.storage.getOracleDivergenceStats(sinceMs);
        // Current snapshot pulled from getState() so the panel header
        // stays in lock-step with what the dashboard's WS push shows.
        const state = this.getState() as any;
        const rs = state?.redstone ?? null;
        return {
          windowHours: hours,
          generatedAt: Date.now(),
          current: rs ? {
            redstone: rs.price,
            redstoneUpdatedAt: rs.updatedAt,
            redstoneStale: rs.stale,
            hl: state.ethPrice ?? null,
            diffBps: rs.divergence?.currentBps ?? null,
            redstoneLeads: rs.divergence?.redstoneLeads ?? null,
          } : null,
          stats: {
            samples: stats.samples,
            avgBps: stats.avgBps,
            maxAbsBps: stats.maxAbsBps,
            pctTimeRedstoneLeads: stats.pctRedstoneLeads,
            // Rolling 5m/1h come from the in-memory ring (more granular
            // than the DB snapshot cadence). Falls back to DB stats when
            // ring is empty.
            ringAvg5mBps: rs?.divergence?.avg5mBps ?? null,
            ringAvg1hBps: rs?.divergence?.avg1hBps ?? null,
            ringMax1hBps: rs?.divergence?.max1hBps ?? null,
          },
          shadow: rs?.shadow ?? null,
          history,
        };
      }),
    );

    // ── LOADOUT OPTIMIZER ─────────────────────────────────────────────
    // Three endpoints serving the ENTERPRISE-tab optimizer panel:
    //   GET  /api/inventory         — operator's owned items + current
    //                                  loadouts in optimizer-friendly shape
    //   POST /api/simulate-loadout  — score a hypothetical allocation
    //   GET  /api/optimize-loadouts — find the best allocation and report
    //                                  the swap diff vs current
    // All three are operator-only (publicGate) — inventory is private state.

    // Helper: pull the operator's inventory + current loadouts from the
    // live state. Returns `null` if the loadout scanner hasn't completed
    // its first poll yet (caller should 503 in that case).
    const operatorInventory = (): {
      address: string;
      statusLevel: number;
      statusXp: number;
      statusBaseST: number;
      statusCleaningBonus: number;
      items: OptimizerItem[];
      currentAssignment: (number | null)[][];
      generators: { id: number; itemIds: (number | null)[]; base: GeneratorBase }[];
    } | null => {
      const state = this.getState();
      const user = state?.loadouts?.user;
      if (!user) return null;

      // The user.inventory array surfaced by the scanner only contains
      // items returned from getInventory(); on this contract version
      // currently-equipped items live exclusively in generators[].slots[]
      // and are NOT duplicated in inventory. Merge both sources so the
      // optimizer sees the full owned roster.
      const items: OptimizerItem[] = [];
      const seenIds = new Set<number>();
      const pushItem = (
        it: { itemId: number; templateId: number; name: string; type: string; rarity: number;
              cr: number; hp: number; eff: number; bc: number; bm: number; disc: number },
      ) => {
        if (seenIds.has(it.itemId)) return;
        if (!(ASSET_TYPES as readonly string[]).includes(it.type)) return;
        seenIds.add(it.itemId);
        items.push({
          itemId: it.itemId, templateId: it.templateId, name: it.name,
          type: it.type as AssetType, rarity: it.rarity,
          cr: it.cr, hp: it.hp, eff: it.eff, bc: it.bc, bm: it.bm, disc: it.disc,
        });
      };
      for (const inv of user.inventory) pushItem(inv);
      for (const g of user.generators) {
        for (const slot of g.slots) {
          if (!slot) continue;
          pushItem({
            itemId: slot.itemId, templateId: slot.templateId, name: slot.name,
            type: slot.category, rarity: slot.rarity,
            cr: slot.cr, hp: slot.hp, eff: slot.eff, bc: slot.bc, bm: slot.bm, disc: slot.disc,
          });
        }
      }
      // currentAssignment[loadoutIndex][assetTypeIndex] = itemId | null
      // Also reverse-derive each generator's base stats from chain
      // aggregate − slot sums. Required for accurate hypothetical
      // simulation: the Enterprise contract adds a non-trivial per-gen
      // constant on top of slot sums (see loadout-simulator.ts).
      const generators = user.generators.map((g) => {
        const ids: (number | null)[] = ASSET_TYPES.map((t) => {
          const slot = g.slots.find((s) => s && s.category === t);
          return slot ? slot.itemId : null;
        });
        const equipped = g.slots.filter((s): s is NonNullable<typeof s> => !!s);
        const base = deriveGeneratorBase(
          { hp: g.hp, cr: g.cr, eff: g.eff, bc: g.bc, bm: g.bm, disc: g.disc, levelBonus: g.levelBonus },
          equipped,
        );
        return { id: g.id, itemIds: ids, base };
      });
      const currentAssignment = generators.map((g) => g.itemIds);

      const sl = Math.max(1, Math.min(10, user.statusLevel || 1));
      return {
        address: user.address,
        statusLevel: sl,
        statusXp: user.statusXp,
        statusBaseST: STATUS_BASE_ST[sl],
        statusCleaningBonus: STATUS_CLEANING_BONUS_PCT[sl],
        items,
        currentAssignment,
        generators,
      };
    };

    this.app.get('/api/inventory', publicGate(async (_req: any, reply: any) => {
      const inv = operatorInventory();
      if (!inv) return reply.status(503).send({ error: 'Loadout scanner has not finished its first poll yet' });
      return inv;
    }));

    // POST /api/simulate-loadout — score a hypothetical allocation. Body:
    //   { loadouts: [{ assetIds: number[] }], statusLevel?: number }
    // assetIds is the set of itemIds equipped in that loadout (1-6 items,
    // any order — we group by type internally). Returns per-loadout stats
    // + a combined cycle output.
    this.app.post<{
      Body: {
        loadouts: { assetIds: number[] }[];
        statusLevel?: number;
      };
    }>(
      '/api/simulate-loadout',
      {
        schema: {
          body: {
            type: 'object',
            required: ['loadouts'],
            properties: {
              loadouts: {
                type: 'array',
                minItems: 1,
                maxItems: 4,
                items: {
                  type: 'object',
                  required: ['assetIds'],
                  properties: {
                    assetIds: {
                      type: 'array',
                      maxItems: 12,        // 6 slots × leeway for the UI to pass extras
                      items: { type: 'integer', minimum: 1 },
                    },
                  },
                  additionalProperties: false,
                },
              },
              statusLevel: { type: 'integer', minimum: 1, maximum: 10 },
            },
            additionalProperties: false,
          },
        },
      },
      publicGate(async (req: any, reply: any) => {
        const inv = operatorInventory();
        if (!inv) return reply.status(503).send({ error: 'Loadout scanner has not finished its first poll yet' });
        const itemsById = new Map<number, OptimizerItem>(inv.items.map((it) => [it.itemId, it]));
        const sl = req.body.statusLevel ?? inv.statusLevel;
        const bases = inv.generators.map((g) => g.base);

        // Strict validation: reject unknown IDs, dup IDs across the
        // submission, and multiple items of the same asset type within
        // a single loadout. Each of these would silently misrepresent
        // what the operator could actually equip in-game, so a 200 with
        // a coerced answer would be misleading.
        const seenIds = new Set<number>();
        const validated: { loadoutIndex: number; ordered: (OptimizerItem | null)[] }[] = [];
        for (let li = 0; li < req.body.loadouts.length; li++) {
          const L = req.body.loadouts[li];
          const byType = new Map<AssetType, OptimizerItem>();
          for (const id of L.assetIds) {
            const it = itemsById.get(id);
            if (!it) {
              return reply.status(400).send({
                error: 'Bad Request',
                message: `Unknown itemId ${id} in loadout #${li + 1}; operator does not own this asset.`,
              });
            }
            if (seenIds.has(id)) {
              return reply.status(400).send({
                error: 'Bad Request',
                message: `itemId ${id} (${it.name}) is assigned to more than one loadout. Each asset can only be in one loadout.`,
              });
            }
            seenIds.add(id);
            if (byType.has(it.type)) {
              const existing = byType.get(it.type)!;
              return reply.status(400).send({
                error: 'Bad Request',
                message: `Loadout #${li + 1} has two ${it.type} assets (${existing.name} + ${it.name}); each loadout has exactly one slot per type.`,
              });
            }
            byType.set(it.type, it);
          }
          const ordered = ASSET_TYPES.map((t) => byType.get(t) ?? null);
          validated.push({ loadoutIndex: li, ordered });
        }

        const loadouts = validated.map(({ loadoutIndex: li, ordered }) => {
          const sim = simulateLoadout(ordered, sl, bases[li] ?? undefined);
          return {
            loadoutIndex: li,
            loadoutName: `E${li + 1}`,
            items: ordered.map((it) => it ? {
              itemId: it.itemId,
              templateId: it.templateId,
              name: it.name,
              type: it.type,
              rarity: it.rarity,
            } : null),
            simulation: sim,
          };
        });
        const combinedOutputUI = loadouts.reduce((a, b) => a + b.simulation.projectedOutputUI, 0);
        const avgSurvived = loadouts.length
          ? loadouts.reduce((a, b) => a + b.simulation.pctCycleSurvived, 0) / loadouts.length
          : 0;
        return {
          statusLevel: sl,
          loadouts,
          combined: { totalOutputUI: combinedOutputUI, avgPctCycleSurvived: avgSurvived },
        };
      }),
    );

    // GET /api/optimize-loadouts?loadouts=N — run the optimizer.
    // Defaults to the operator's current number of unlocked enterprises.
    this.app.get<{ Querystring: { loadouts?: string; statusLevel?: string } }>(
      '/api/optimize-loadouts',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              loadouts: { type: 'integer', minimum: 1, maximum: 4 },
              statusLevel: { type: 'integer', minimum: 1, maximum: 10 },
            },
          },
        },
      },
      publicGate(async (req: any, reply: any) => {
        const inv = operatorInventory();
        if (!inv) return reply.status(503).send({ error: 'Loadout scanner has not finished its first poll yet' });
        const numLoadouts = req.query.loadouts ? Number(req.query.loadouts) : inv.generators.length;
        if (numLoadouts < 1) {
          return reply.status(400).send({ error: 'No unlocked loadouts to optimize' });
        }
        const sl = req.query.statusLevel ? Number(req.query.statusLevel) : inv.statusLevel;
        // Truncate currentAssignment to numLoadouts (caller may request
        // optimization for fewer enterprises than the operator currently owns).
        const currentAssignment = inv.currentAssignment.slice(0, numLoadouts);
        const generatorBases: (GeneratorBase | null)[] = [];
        for (let i = 0; i < numLoadouts; i++) {
          generatorBases.push(inv.generators[i]?.base ?? null);
        }
        const t0 = Date.now();
        const result = optimizeLoadouts({
          items: inv.items,
          numLoadouts,
          statusLevel: sl,
          currentAssignment,
          generatorBases,
        });
        const elapsedMs = Date.now() - t0;
        return { ...result, statusBaseST: STATUS_BASE_ST[sl], statusCleaningBonus: STATUS_CLEANING_BONUS_PCT[sl], elapsedMs };
      }),
    );

    // ── MISSION CONTROL ────────────────────────────────────────
    // Aggregator endpoint feeding the sticky OPS-tab Mission Control
    // strip. Combines what the dashboard would otherwise pull from
    // four separate endpoints (efficiency / burn-vs-claim / schedule /
    // copy stats) into one polled response. The 1Hz real-time slice
    // (danger / corps / hedge / NH) stays on the WS push.
    //
    // Polled at 30s on the client. Heavy enough that we cache via
    // 30s s-maxage so repeat hits within the window are cheap.
    this.app.get('/api/mission-control', publicGate(async (_req: any, reply: any) => {
      const state = this.getState() as any;
      const eff24h = computeEfficiency(this.storage, { windowHours: 24 });
      const eff7d  = computeEfficiency(this.storage, { windowHours: 168 });
      const bvc = this.storage.getOperatorBurnVsClaim({
        operator: config.walletAddress,
        days: 7,
      });

      // Pull strategy slices so we can show "copy vs auto" SR delta.
      const stratByName = new Map<string, any>(
        eff24h.by_strategy.map((s: any) => [s.strategy, s]),
      );
      const copy = stratByName.get('manual:copy') ?? null;
      const autoDrug = stratByName.get('auto:all-drug') ?? null;
      // (auto-restart) ops have no strategy tag — back into them via
      // overall − tagged strategies for a denser baseline comparator.
      const taggedOps   = eff24h.by_strategy.reduce((s: number, r: any) => s + r.ops, 0);
      const taggedWins  = eff24h.by_strategy.reduce((s: number, r: any) => s + r.wins, 0);
      const untaggedOps   = Math.max(0, eff24h.overall.ops  - taggedOps);
      const untaggedWins  = Math.max(0, eff24h.overall.wins - taggedWins);
      const autoRestartSr = untaggedOps > 0 ? untaggedWins / untaggedOps : null;

      // Pull operator claims from DB directly. The in-memory whaleClaims
      // ring only holds the most recent N claims across ALL whales, so
      // operator's claims get evicted under heavy network activity and
      // we'd undercount today's revenue. DB join via cycleBurnVsClaim
      // gives us the authoritative cycle-by-cycle list.
      const bvc24h = this.storage.getOperatorBurnVsClaim({
        operator: config.walletAddress,
        days: 1,
      });
      const claims24h = bvc24h.cycles;
      const sumClaims24h = claims24h.reduce((s, c) => s + c.claim_usdm, 0);
      const lastClaim = claims24h.length > 0
        ? claims24h.sort((a, b) => b.claim_ts - a.claim_ts)[0]
        : null;

      // Pool / cycle data from the existing loadout-scanner snapshot.
      const cycle = state?.loadouts?.cycle ?? null;
      const cycleTotals = (state?.whaleClaims?.cycleTotals ?? []) as Array<{
        cycle_id: number; total_usdm: number; n_claims: number;
      }>;
      const prevCycleTotal = cycleTotals[0] ?? null;

      // Operator share estimate = last cycle claim / last cycle total.
      // Stable proxy until proper laundering-cash denominator wiring.
      const opShare = (lastClaim && prevCycleTotal?.total_usdm)
        ? lastClaim.claim_usdm / prevCycleTotal.total_usdm
        : null;
      // Estimated current-cycle claim = share × current netPool.
      const estClaim = (cycle && opShare)
        ? opShare * (cycle.netPool ?? cycle.pool ?? 0)
        : null;

      // ── Alerts (priority 0 = most urgent) ────────────────
      type Alert = { icon: string; text: string; priority: number };
      const alerts: Alert[] = [];
      const hktHour = (new Date().getUTCHours() + 8) % 24;
      // 1. Upcoming schedule pause
      const sched = (state?.scheduleRegime === 'weekend'
        ? state?.scheduleConfig?.weekend
        : state?.scheduleConfig?.weekday)
        ?? null;
      // Schedule may live on corpBotStatus if not directly exposed
      const schedFromStatus = state?.corpBotStatus?.schedule
        ?? null;
      const scheduleArr: string[] | null = sched ?? schedFromStatus;
      if (Array.isArray(scheduleArr) && scheduleArr.length === 24) {
        for (let h = 1; h <= 3; h++) {
          const hr = (hktHour + h) % 24;
          if (scheduleArr[hr] === 'paused') {
            // Build a human-readable "in Xh Xmin" — use current minute
            // for sub-hour precision.
            const minsInHour = new Date(Date.now() + 8 * 3600_000).getUTCMinutes();
            const totalMin = h * 60 - minsInHour;
            const hh = Math.floor(totalMin / 60);
            const mm = totalMin % 60;
            const ago = hh > 0 ? `${hh}h ${mm}min` : `${mm}min`;
            alerts.push({ icon: '⚠', text: `Schedule: ${String(hr).padStart(2,'0')}h pause in ${ago}`, priority: 1 });
            break;
          }
        }
      }
      // 2. Copy mode performance
      if (copy && copy.ops >= 5) {
        if (autoRestartSr != null && copy.sr > autoRestartSr) {
          alerts.push({
            icon: '✅',
            text: `Copy SR ${(copy.sr*100).toFixed(1)}% beating auto-restart ${(autoRestartSr*100).toFixed(0)}%`,
            priority: 3,
          });
        } else if (autoRestartSr != null && copy.sr < autoRestartSr - 0.05) {
          alerts.push({
            icon: '⚠',
            text: `Copy SR ${(copy.sr*100).toFixed(1)}% — underperforming auto`,
            priority: 1,
          });
        }
      }
      // 3. NH penalty active
      const nhPen = state?.nhPenalty?.penalty ?? 0;
      if (nhPen > 0) {
        const minSince = state?.networkHealth
          ? Math.max(0, Math.round((Date.now() - (state.networkHealth.scannedAt ?? Date.now())) / 60_000))
          : 0;
        alerts.push({
          icon: '⚠',
          text: `NH penalty +${nhPen} (cascade ${minSince}min ago)`,
          priority: 1,
        });
      }
      // 4. Hedge margin warning (live mode only)
      if (state?.hedge?.mode === 'live' && state?.hedge?.activeHedge) {
        const ah = state.hedge.activeHedge;
        // Margin check is a placeholder — live SDK integration not yet
        // wired. Surface the active position as an info alert for now.
        alerts.push({
          icon: '🛡',
          text: `Hedge active: $${ah.notional?.toFixed(0)} short, TP $${ah.takeProfitPrice?.toFixed(2)}`,
          priority: 2,
        });
      }
      // 5. DIRTY runway from wallet balance + 24h burn estimate.
      const dirtyBal = state?.walletBalances?.dirty ?? 0;
      const dailyDirtyBurn = eff24h.overall.ops > 0
        ? eff24h.overall.ops * 200 / 24 * 24  // packs cost only; rough
        : 0;
      if (dirtyBal > 0 && dailyDirtyBurn > 0 && dirtyBal / dailyDirtyBurn < 2) {
        alerts.push({
          icon: '⚠',
          text: `DIRTY runway ${(dirtyBal/dailyDirtyBurn).toFixed(1)}d at recent spend`,
          priority: 2,
        });
      }
      // 6. INF runway
      const infBal = state?.walletBalances?.inf ?? 0;
      const infBurnedPerHr = eff24h.overall.ops > 0
        ? eff24h.overall.inf_spent / 24
        : 0;
      const infRunwayHrs = infBurnedPerHr > 0 ? infBal / infBurnedPerHr : Infinity;
      if (Number.isFinite(infRunwayHrs) && infRunwayHrs < 24) {
        alerts.push({
          icon: '⚠',
          text: `INF runway ${infRunwayHrs.toFixed(1)}h — top up before failure burn drains`,
          priority: 1,
        });
      }
      // Sort by priority, take top 3
      const topAlerts = alerts.sort((a, b) => a.priority - b.priority).slice(0, 3);

      reply.header('Cache-Control', 'public, max-age=15, s-maxage=30');
      return jsonSafeInfinity({
        generatedAt: Date.now(),
        pnl: {
          today: {
            // Sum ALL operator claims in the last 24h (not just the latest)
            // so the net P&L reflects total inflow vs total INF burned.
            claims: sumClaims24h,
            netUsdm: sumClaims24h - eff24h.overall.inf_spent,
            infBurned: eff24h.overall.inf_spent,
            dirtyEarned: eff24h.overall.dirty_earned,
            dirtyPerInfLost: eff24h.overall.dirty_per_inf,
            srPct: eff24h.overall.sr * 100,
            ops: eff24h.overall.ops,
            claimCount: claims24h.length,
          },
          lastCycle: lastClaim ? {
            cycleId: lastClaim.cycle_id,
            claim: lastClaim.claim_usdm,
            ts: lastClaim.claim_ts,
          } : null,
          avg7d: {
            dirtyPerInfLost: eff7d.overall.dirty_per_inf,
            netPerDay: bvc.aggregate.net_per_day,
            srPct: eff7d.overall.sr * 100,
          },
        },
        nextCycle: cycle ? {
          cycleId:        cycle.cycleId,
          poolSize:       cycle.netPool ?? cycle.pool ?? 0,
          estShare:       opShare,
          estClaim,
          endsInSec:      cycle.secondsRemaining,
          elapsedSec:     cycle.secondsElapsed,
          // Best estimate of "next" cycle pool — use the median of the
          // last 3 closed cycle totals (excluding genesis cycles where
          // total ≈ 0). Filters cold-start outliers without needing
          // chain-side reserve math.
          prevCyclesAvg: (() => {
            const stableTotals = cycleTotals
              .filter(c => c.total_usdm > 5000)
              .slice(0, 3)
              .map(c => c.total_usdm);
            if (stableTotals.length === 0) return null;
            return stableTotals.reduce((a, b) => a + b, 0) / stableTotals.length;
          })(),
        } : null,
        copyMode: copy ? {
          enabled: state?.corpBotStatus?.copyMode?.enabled ?? false,
          recentSR: copy.sr,
          autoRestartSR: autoRestartSr,
          opsLast24h: copy.ops,
          dirtyPerInf: copy.dirty_per_inf,
        } : null,
        alerts: topAlerts,
      });
    }));

    // Health check
    this.app.get('/api/health', async () => {
      const state = this.getState();
      return {
        status: 'ok',
        uptime: state.meta.uptime,
        sources: state.connections,
        activeSources: state.meta.sources,
        tickCount: state.meta.tickCount,
      };
    });

    // Custom error handler for validation errors
    this.app.setErrorHandler((error: any, _request, reply) => {
      if (error.validation) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: error.message,
        });
      }
      logger.error({ err: error }, 'Unhandled error');
      return reply.status(500).send({ error: 'Internal Server Error' });
    });

    // Start listening
    await this.app.listen({ port: config.port, host: config.host });
    logger.info({ port: config.port, host: config.host }, `[API] Server running at http://${config.host}:${config.port}`);
  }

  // Broadcast state to all WS clients (delta-based) — both private /ws and
  // public /ws/network. The public stream gets a stripped state.
  broadcast(state: DashboardState) {
    // Refund-on-success means economics.dirtyPerInf can be Infinity.
    // Sanitize ONCE per tick so all downstream client.send + structuredClone
    // operations work on a JSON-safe copy. The dashboard's restoreInfinity()
    // helper reverses the transform on receipt.
    const safeState = jsonSafeInfinity(state);
    // Private operator stream
    for (const client of this.clients) {
      try {
        if (client.readyState !== 1) continue;
        const prev = this.clientPrevState.get(client);
        if (!prev) {
          client.send(JSON.stringify({ type: 'state', full: true, data: safeState }));
        } else {
          const diff = deepDiff(prev, safeState);
          if (diff !== null) {
            client.send(JSON.stringify({ type: 'state', full: false, data: diff }));
          }
        }
        this.clientPrevState.set(client, structuredClone(safeState));
      } catch {
        this.clients.delete(client);
        this.clientPrevState.delete(client);
      }
    }

    // Public stream — pick the safe slice once per broadcast, then delta-diff
    // against each public client's previous public-slice snapshot.
    if (this.publicClients.size > 0) {
      // Use the already-Infinity-sanitized state for the public slice too.
      const publicState = jsonSafeInfinity(pickPublicState(state));
      for (const client of this.publicClients) {
        try {
          if (client.readyState !== 1) continue;
          const prev = this.publicClientPrevState.get(client);
          if (!prev) {
            client.send(JSON.stringify({ type: 'state', full: true, data: publicState }));
          } else {
            const diff = deepDiff(prev, publicState);
            if (diff !== null) {
              client.send(JSON.stringify({ type: 'state', full: false, data: diff }));
            }
          }
          this.publicClientPrevState.set(client, structuredClone(publicState));
        } catch {
          this.publicClients.delete(client);
          this.publicClientPrevState.delete(client);
        }
      }
    }
  }

  // Broadcast alert
  broadcastAlert(alert: any) {
    const msg = JSON.stringify({ type: 'alert', data: alert });
    for (const client of this.clients) {
      try {
        if (client.readyState === 1) client.send(msg);
      } catch {
        this.clients.delete(client);
        this.clientPrevState.delete(client);
      }
    }
  }

  async stop() {
    await this.app.close();
  }
}
