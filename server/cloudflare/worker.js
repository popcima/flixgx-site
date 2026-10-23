import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { httpServerHandler } from 'cloudflare:node';
import { createApp } from '../api/app.js';
import { ApiError } from '../api/errors.js';
import { readBody } from '../api/network.js';
import { MEDIA_HOSTS, resolveProvider } from '../api/provider.js';
import { createTransport } from './network.js';
import { SQLiteSessionStore } from './store.js';

const activeRequest = new AsyncLocalStorage();
const CLIENT_IP_HEADER = 'x-flixgx-client-ip';
const publicPlayback = /^\/api\/playback\/(?:movie\/[^/]+|tv\/[^/]+\/[^/]+\/[^/]+)$/;
const split = value => (value || '').split(',').map(item => item.trim()).filter(Boolean);

function upstream(value, options) {
  const context = activeRequest.getStore();
  if (!context || context.closed) throw new Error('Upstream request has no active request context.');
  context.transport ||= createTransport(context.proxyURL);
  return context.transport.request(value, options);
}

async function tmdbClient(path, params, token) {
  if (!token) throw new ApiError(503, 'TMDB_NOT_CONFIGURED', 'Set your TMDB_READ_TOKEN on the server to enable metadata and search. Resolving known TMDB IDs works without it.');
  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await upstream(url.href, { hosts: ['api.themoviedb.org'], headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (response.statusCode !== 200) {
    response.destroy();
    throw new ApiError(response.statusCode === 404 ? 404 : 502, 'TMDB_ERROR', `TMDB returned HTTP ${response.statusCode}.`);
  }
  return JSON.parse((await readBody(response)).toString());
}

function responseWithCleanup(response, cleanup) {
  if (!response.body) { void cleanup(); return response; }
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { await cleanup(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) {
        await cleanup(); controller.error(error);
      }
    },
    async cancel(reason) {
      // Abort the upstream socket before awaiting cancellation of a reader
      // that may still be waiting for that same socket to produce data.
      const closed = cleanup();
      await Promise.allSettled([reader.cancel(reason), closed]);
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

// A single SQLite Durable Object keeps the existing capacity limits meaningful,
// persists signed playback sessions, and supplies the CPU budget for TLS work.
export class FlixGXAPI {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.alarmUpdate = Promise.resolve();
    const baseURL = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const parsed = new URL(baseURL);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('PUBLIC_BASE_URL must be an HTTP(S) origin without a path.');
    }
    const apiKey = env.API_KEY || ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS api_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const saved = [...ctx.storage.sql.exec('SELECT value FROM api_settings WHERE name = ?', 'api_key')][0];
      if (saved) return saved.value;
      const value = randomBytes(32).toString('hex');
      ctx.storage.sql.exec('INSERT INTO api_settings (name, value) VALUES (?, ?)', 'api_key', value);
      return value;
    });
    const extraHosts = split(env.EXTRA_MEDIA_HOSTS);
    this.store = new SQLiteSessionStore([...MEDIA_HOSTS, ...extraHosts], {
      sql: ctx.storage.sql,
      onExpiry: timestamp => this.scheduleAlarm(timestamp),
    });
    this.store.prune();
    const nextExpiry = this.store.nextExpiry();
    if (nextExpiry !== null) this.scheduleAlarm(nextExpiry);

    const api = createApp({
      baseURL, apiKey, corsOrigins: split(env.CORS_ORIGINS),
      tmdbToken: env.TMDB_READ_TOKEN || '', extraHosts,
    }, {
      store: this.store, upstream, tmdbClient,
      provider: target => {
        // Resolver coalesces requests for the same title. Give that shared job
        // its own bounded transport so one disconnected viewer cannot cancel
        // another viewer's resolution.
        const transport = createTransport(env.UPSTREAM_PROXY_URL || '');
        const job = resolveProvider(target, { upstream: transport.request }).finally(() => transport.close());
        ctx.waitUntil(job.catch(() => {}));
        return job;
      },
      proxyConfigured: () => Boolean(env.UPSTREAM_PROXY_URL),
      getClientIP: req => req.headers[CLIENT_IP_HEADER] || 'unknown',
      transaction: operation => ctx.storage.transactionSync(operation),
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url, baseURL);
      if (publicPlayback.test(url.pathname)) {
        req.url = url.pathname.replace('/api/playback/', '/v1/streams/') + url.search;
        req.headers.authorization = `Bearer ${apiKey}`;
      }
      api.emit('request', req, res);
    });
    this.handler = httpServerHandler(server);
  }

  scheduleAlarm(timestamp) {
    this.alarmUpdate = this.alarmUpdate.catch(() => {}).then(async () => {
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || timestamp < alarm) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, timestamp));
    });
    this.ctx.waitUntil(this.alarmUpdate);
  }

  async alarm() {
    this.store.prune();
    const nextExpiry = this.store.nextExpiry();
    if (nextExpiry !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, nextExpiry));
  }

  async fetch(request) {
    const context = { proxyURL: this.env.UPSTREAM_PROXY_URL || '', transport: null, closed: false };
    let cleanupPromise;
    const cleanup = () => {
      if (!cleanupPromise) {
        context.closed = true;
        request.signal.removeEventListener('abort', onAbort);
        cleanupPromise = context.transport ? context.transport.close() : Promise.resolve();
      }
      return cleanupPromise;
    };
    const onAbort = () => { this.ctx.waitUntil(cleanup()); };
    request.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (request.signal.aborted) throw new Error('Request cancelled.');
      const response = await activeRequest.run(context, () => this.handler.fetch(request, this.env, this.ctx));
      return responseWithCleanup(response, cleanup);
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path !== '/health' && !path.startsWith('/v1/') && !publicPlayback.test(path)) {
      return Response.json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    // The edge replaces this header before forwarding. User-supplied values
    // cannot bypass the API's per-IP limit inside the Durable Object.
    const headers = new Headers(request.headers);
    const clientIP = request.headers.get('CF-Connecting-IP') || '';
    headers.set(CLIENT_IP_HEADER, isIP(clientIP) ? clientIP : 'unknown');
    const id = env.PLAYBACK_API.idFromName('playback-v1');
    return env.PLAYBACK_API.get(id).fetch(new Request(request, { headers }));
  },
};
