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
  private storage: Storage;
  private getState: () => DashboardState;
  private onOpStatsChanged?: () => void;

  constructor(
    storage: Storage,
    getState: () => DashboardState,
    onOpStatsChanged?: () => void,
  ) {
    this.storage = storage;
    this.getState = getState;
    this.onOpStatsChanged = onOpStatsChanged;
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

    // --- WebSocket endpoint ---
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
    });

    // --- REST endpoints ---

    // Current state snapshot
    this.app.get('/api/state', async () => {
      return this.getState();
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

  // Broadcast state to all WS clients (delta-based)
  broadcast(state: DashboardState) {
    for (const client of this.clients) {
      try {
        if (client.readyState !== 1) continue;
        const prev = this.clientPrevState.get(client);
        if (!prev) {
          // No previous state — send full
          client.send(JSON.stringify({ type: 'state', full: true, data: state }));
        } else {
          const diff = deepDiff(prev, state);
          if (diff !== null) {
            client.send(JSON.stringify({ type: 'state', full: false, data: diff }));
          }
          // else: no changes, skip send
        }
        this.clientPrevState.set(client, structuredClone(state));
      } catch {
        this.clients.delete(client);
        this.clientPrevState.delete(client);
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
