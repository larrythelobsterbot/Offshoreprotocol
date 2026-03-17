import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import path from 'path';
import type { WebSocket } from 'ws';
import type { DashboardState, AlertEvent } from '../types';
import { Storage } from '../storage/db';
import { config } from '../config';

export class ApiServer {
  private app = Fastify({ logger: false });
  private clients = new Set<WebSocket>();
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
        console.log(`[WS] Client connected (${this.clients.size} total)`);

        // Send initial state
        try {
          socket.send(JSON.stringify({ type: 'state', data: this.getState() }));
        } catch { /* client may have disconnected */ }

        socket.on('close', () => {
          this.clients.delete(socket);
          console.log(`[WS] Client disconnected (${this.clients.size} total)`);
        });

        socket.on('error', () => {
          this.clients.delete(socket);
        });
      });
    });

    // --- REST endpoints ---

    // Current state snapshot
    this.app.get('/api/state', async () => {
      return this.getState();
    });

    // Historical indicators
    this.app.get<{ Querystring: { since?: string; from?: string; to?: string } }>(
      '/api/indicators', async (req) => {
        const { since, from, to } = req.query;
        if (from && to) {
          return this.storage.getIndicatorsRange(parseInt(from), parseInt(to));
        }
        const sinceMs = since ? parseInt(since) : Date.now() - 3600_000;
        return this.storage.getIndicatorsSince(sinceMs);
      }
    );

    // Recent alerts
    this.app.get<{ Querystring: { since?: string } }>(
      '/api/alerts', async (req) => {
        const sinceMs = req.query.since ? parseInt(req.query.since) : Date.now() - 86400_000;
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
    console.log(`[API] Server running at http://${config.host}:${config.port}`);
  }

  // Broadcast state to all WS clients
  broadcast(state: DashboardState) {
    const msg = JSON.stringify({ type: 'state', data: state });
    for (const client of this.clients) {
      try {
        if (client.readyState === 1) client.send(msg);
      } catch {
        this.clients.delete(client);
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
      }
    }
  }

  async stop() {
    await this.app.close();
  }
}
