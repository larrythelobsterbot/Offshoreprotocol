import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import path from 'path';
import { timingSafeEqual } from 'crypto';
import type { WebSocket } from 'ws';
import type { DashboardState, StoredIndicator } from '../types';
// (config used at runtime to gate operator-only endpoints in PUBLIC_MODE)
import { Storage } from '../storage/db';
import { config } from '../config';
import { logger } from '../logger';
import type { WalletTracker } from '../feeds/wallet-tracker';

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

  // Sample the current per-op INF stake from any active corp's tradeInfo.
  // This is a network parameter (game contract-decided cost — same for any
  // wallet running the same op mode), not operator-specific. We just happen
  // to have it readily available because we already poll our own corps.
  // Falls through to null if no corps are currently active.
  let opCostInf: number | null = null;
  try {
    const corps = (state as any).corpState?.corps;
    if (Array.isArray(corps)) {
      const active = corps.find((c: any) => c?.tradeInfo?.active && c?.tradeInfo?.influence);
      if (active) {
        opCostInf = Number(BigInt(active.tradeInfo.influence)) / 1e18;
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
    logger: {
      level: config.logLevel,
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

  constructor(
    storage: Storage,
    getState: () => DashboardState,
    onOpStatsChanged?: () => void,
    walletTracker?: WalletTracker,
  ) {
    this.storage = storage;
    this.getState = getState;
    this.onOpStatsChanged = onOpStatsChanged;
    this.walletTracker = walletTracker;
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
        const id = this.storage.insertOpOutcome({
          ts: ts ?? Date.now(),
          opType,
          succeeded: succeeded ? 1 : 0,
          dirtyEarned,
          baseReward: base,
          note,
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
    if (this.walletTracker) {
      const RL_WINDOW_MS = 60_000;
      const RL_MAX_REQ_PER_WINDOW = 60;
      const RL_MAX_DISTINCT_WALLETS = 10;
      type Bucket = { count: number; windowStart: number; wallets: Set<string> };
      const buckets = new Map<string, Bucket>();

      const rateLimited = (req: any, wallet: string): { ok: boolean; retryAfter?: number } => {
        // X-Forwarded-For (set by trusted proxy/CF) takes precedence; fall
        // back to socket. We only use the FIRST hop so a malicious header
        // can't inject many fake IPs.
        const xff = (req.headers['x-forwarded-for'] || '').toString().split(',')[0]?.trim();
        const ip = xff || req.ip || 'unknown';
        const now = Date.now();
        let b = buckets.get(ip);
        if (!b || now - b.windowStart > RL_WINDOW_MS) {
          b = { count: 0, windowStart: now, wallets: new Set() };
          buckets.set(ip, b);
        }
        if (b.count >= RL_MAX_REQ_PER_WINDOW) {
          const retryAfter = Math.ceil((RL_WINDOW_MS - (now - b.windowStart)) / 1000);
          return { ok: false, retryAfter };
        }
        // Distinct-wallet cap is checked AFTER req-count so a flood from
        // one IP can't ingest 60 unique wallets in a window.
        if (!b.wallets.has(wallet) && b.wallets.size >= RL_MAX_DISTINCT_WALLETS) {
          return { ok: false, retryAfter: Math.ceil((RL_WINDOW_MS - (now - b.windowStart)) / 1000) };
        }
        b.count++;
        b.wallets.add(wallet);
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
          const limit = rateLimited(req, wallet);
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
            logger.warn({ err: err.message, wallet }, '[track] fetch failed');
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
    // Private operator stream
    for (const client of this.clients) {
      try {
        if (client.readyState !== 1) continue;
        const prev = this.clientPrevState.get(client);
        if (!prev) {
          client.send(JSON.stringify({ type: 'state', full: true, data: state }));
        } else {
          const diff = deepDiff(prev, state);
          if (diff !== null) {
            client.send(JSON.stringify({ type: 'state', full: false, data: diff }));
          }
        }
        this.clientPrevState.set(client, structuredClone(state));
      } catch {
        this.clients.delete(client);
        this.clientPrevState.delete(client);
      }
    }

    // Public stream — pick the safe slice once per broadcast, then delta-diff
    // against each public client's previous public-slice snapshot.
    if (this.publicClients.size > 0) {
      const publicState = pickPublicState(state);
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
