import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import path from 'path';
import type { WebSocket } from 'ws';
import type { DashboardState, AlertEvent } from '../types';
import { Storage } from '../storage/db';
import { config } from '../config';
import { logger } from '../logger';

// Deep-diff utility: returns an object containing only changed fields
function deepDiff(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> | null {
  const diff: Record<string, unknown> = {};
  let hasChanges = false;

  for (const key of Object.keys(next)) {
    const pVal = prev[key];
    const nVal = next[key];

    if (pVal === nVal) continue;

    if (
      pVal !== null && nVal !== null &&
      typeof pVal === 'object' && typeof nVal === 'object' &&
      !Array.isArray(pVal) && !Array.isArray(nVal)
    ) {
      const nested = deepDiff(pVal as Record<string, unknown>, nVal as Record<string, unknown>);
      if (nested !== null) {
        diff[key] = nested;
        hasChanges = true;
      }
    } else if (JSON.stringify(pVal) !== JSON.stringify(nVal)) {
      diff[key] = nVal;
      hasChanges = true;
    }
  }

  return hasChanges ? diff : null;
}

export class ApiServer {
  private app = Fastify({
    logger: {
      level: config.logLevel,
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  });
  private clients = new Set<WebSocket>();
  private clientPrevState = new Map<WebSocket, DashboardState>();
  private storage: Storage;
  private getState: () => DashboardState;

  constructor(storage: Storage, getState: () => DashboardState) {
    this.storage = storage;
    this.getState = getState;
  }

  async start() {
    // Plugins
    await this.app.register(fastifyCors, { origin: true });
    await this.app.register(fastifyWebsocket);
    await this.app.register(fastifyStatic, {
      root: path.join(process.cwd(), 'public'),
      prefix: '/',
    });

    // --- WebSocket endpoint ---
    this.app.register(async (app) => {
      app.get('/ws', { websocket: true }, (socket, _req) => {
        this.clients.add(socket);
        logger.info({ clientCount: this.clients.size }, 'WebSocket client connected');

        // Send full state on initial connection
        try {
          const state = this.getState();
          socket.send(JSON.stringify({ type: 'full', data: state }));
          this.clientPrevState.set(socket, structuredClone(state));
        } catch { /* client may have disconnected */ }

        socket.on('close', () => {
          this.clients.delete(socket);
          this.clientPrevState.delete(socket);
          logger.info({ clientCount: this.clients.size }, 'WebSocket client disconnected');
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
              since: { type: 'string', pattern: '^[0-9]+$' },
              from: { type: 'string', pattern: '^[0-9]+$' },
              to: { type: 'string', pattern: '^[0-9]+$' },
            },
          },
        },
      },
      async (req, reply) => {
        const { since, from, to } = req.query;
        if (from && to) {
          const fromNum = parseInt(from);
          const toNum = parseInt(to);
          if (fromNum <= 0 || toNum <= 0) {
            return reply.status(400).send({ error: 'from and to must be positive integers' });
          }
          if (fromNum >= toNum) {
            return reply.status(400).send({ error: 'from must be less than to' });
          }
          return this.storage.getIndicatorsRange(fromNum, toNum);
        }
        if (since) {
          const sinceNum = parseInt(since);
          if (sinceNum <= 0) {
            return reply.status(400).send({ error: 'since must be a positive integer' });
          }
          return this.storage.getIndicatorsSince(sinceNum);
        }
        const sinceMs = Date.now() - 3600_000;
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
              since: { type: 'string', pattern: '^[0-9]+$' },
            },
          },
        },
      },
      async (req, reply) => {
        if (req.query.since) {
          const sinceNum = parseInt(req.query.since);
          if (sinceNum <= 0) {
            return reply.status(400).send({ error: 'since must be a positive integer' });
          }
          return this.storage.getAlertsSince(sinceNum);
        }
        const sinceMs = Date.now() - 86400_000;
        return this.storage.getAlertsSince(sinceMs);
      }
    );

    // DB stats
    this.app.get('/api/stats', async () => {
      return this.storage.getStats();
    });

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

    // Start listening
    await this.app.listen({ port: config.port, host: config.host });
    logger.info({ port: config.port, host: config.host }, 'API server running');
  }

  // Broadcast delta or full state to all WS clients
  broadcast(state: DashboardState) {
    for (const client of this.clients) {
      try {
        if (client.readyState !== 1) continue;

        const prev = this.clientPrevState.get(client);
        if (!prev) {
          // No previous state — send full
          client.send(JSON.stringify({ type: 'full', data: state }));
        } else {
          // Compute diff
          const diff = deepDiff(
            prev as unknown as Record<string, unknown>,
            state as unknown as Record<string, unknown>,
          );
          if (diff !== null) {
            client.send(JSON.stringify({ type: 'delta', data: diff }));
          }
          // If no diff, skip sending
        }
        this.clientPrevState.set(client, structuredClone(state));
      } catch {
        this.clients.delete(client);
        this.clientPrevState.delete(client);
      }
    }
  }

  // Broadcast alert
  broadcastAlert(alert: AlertEvent) {
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
