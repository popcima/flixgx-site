import { resolve4, resolve6 } from 'node:dns/promises';
import { Readable } from 'node:stream';
import ipaddr from 'ipaddr.js';
import { Client } from 'tunnelfetch';
import { openTunnel, parseProxy } from 'tunnelfetch/proxy';
import { ApiError } from '../api/errors.js';

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CREDENTIALS = new Set(['authorization', 'cookie', 'proxy-authorization']);

function publicAddress(value) {
  try { return ipaddr.process(value).range() === 'unicast'; } catch { return false; }
}

function allowedURL(value, hosts = []) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError(502, 'UNSAFE_UPSTREAM', 'Invalid upstream URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new ApiError(502, 'UNSAFE_UPSTREAM', 'Upstream host is outside the configured provider allowlist.');
  }
  return url;
}

function safeError(error) {
  if (error instanceof ApiError) return error;
  if (String(error?.code).startsWith('TIMEOUT')) return new ApiError(504, 'UPSTREAM_TIMEOUT', 'Upstream request timed out.');
  if (String(error?.code).startsWith('CERT_') || String(error?.code).startsWith('TLS_')) {
    return new ApiError(502, 'UPSTREAM_TLS_ERROR', 'The provider secure connection could not be verified.');
  }
  if (['PROXY_AUTH_REQUIRED', 'PROXY_AUTH_FAILED'].includes(error?.code)) {
    return new ApiError(502, 'PROXY_AUTH_REQUIRED', 'The upstream proxy rejected its configured credentials.');
  }
  return new ApiError(502, 'UPSTREAM_ERROR', 'The provider connection failed.');
}

function proxyConfiguration(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return { ...parseProxy(value) };
  } catch {
    throw new ApiError(500, 'PROXY_CONFIGURATION', 'UPSTREAM_PROXY_URL must specify an HTTP or HTTPS forward proxy.');
  }
}

// The factory stays synchronous for the provider API. Cloudflare's runtime-only import is
// deferred until the first request, which also permits offline Node tests of the adapter.
export function createTransport(proxyURL) {
  return createTransportWithDependencies(proxyURL, {
    loadConnect: async () => (await import('cloudflare:sockets')).connect,
    resolve4, resolve6, Client, openTunnel,
  });
}

export function createTransportWithDependencies(proxyURL, dependencies) {
  const proxy = proxyConfiguration(proxyURL);
  const controller = new AbortController();
  const pins = new Map();
  const sockets = new Set();
  const bodies = new Set();
  const timers = new Set();
  let connect, client, ready, closed = false;

  function raceAbort(promise) {
    const signal = controller.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  async function resolvePublic(hostname) {
    const literal = hostname.replace(/^\[|\]$/g, '');
    if (ipaddr.isValid(literal)) {
      if (!publicAddress(literal)) throw new ApiError(502, 'UNSAFE_UPSTREAM', 'Upstream resolved to a non-public address.');
      return literal;
    }
    const answers = await raceAbort(Promise.allSettled([
      dependencies.resolve4(hostname), dependencies.resolve6(hostname),
    ]));
    const addresses = [];
    for (const answer of answers) {
      if (answer.status === 'fulfilled') addresses.push(...answer.value);
      else if (!['ENODATA', 'ENOTFOUND', 'ENOENT'].includes(answer.reason?.code)) {
        throw new ApiError(502, 'UPSTREAM_DNS', 'The provider address could not be resolved.');
      }
    }
    if (!addresses.length || addresses.some(address => !publicAddress(address))) {
      throw new ApiError(502, 'UNSAFE_UPSTREAM', 'Upstream resolved to a non-public address.');
    }
    return addresses.find(address => ipaddr.parse(address).kind() === 'ipv4') || addresses[0];
  }

  function trackedConnect(address, options) {
    controller.signal.throwIfAborted();
    const socket = connect(address, options);
    sockets.add(socket);
    socket.closed?.then(() => sockets.delete(socket), () => sockets.delete(socket));
    return socket;
  }

  // tunnelfetch accepts a synchronous socket factory, then awaits its `opened` promise before
  // reading the streams. This facade supplies a CONNECT tunnel to a checked IP while leaving
  // the original URL hostname intact for TLS SNI, certificate validation and the HTTP Host.
  function pinnedConnect(address) {
    const ip = pins.get(address.hostname);
    if (!ip || address.port !== 443 || !publicAddress(ip)) {
      throw new ApiError(502, 'UNSAFE_UPSTREAM', 'An unvalidated upstream connection was refused.');
    }
    let tunnel;
    const opened = raceAbort(dependencies.openTunnel({
      proxy, target: { hostname: ip, port: 443 }, connect: trackedConnect,
      signal: controller.signal, limits: { maxProxyReplyBytes: 16384 },
    })).then(value => {
      if (controller.signal.aborted) {
        void Promise.resolve(value.close?.()).catch(() => {});
        throw controller.signal.reason;
      }
      tunnel = value;
    });
    opened.catch(() => {});
    return {
      opened,
      get readable() { return tunnel.readable; },
      get writable() { return tunnel.writable; },
      close: async () => { await opened.catch(() => {}); await tunnel?.close?.(); },
    };
  }

  async function initialize() {
    if (!ready) ready = (async () => {
      connect = await dependencies.loadConnect();
      controller.signal.throwIfAborted();
      // Proxy configuration is server controlled, but still reject private addresses. For an
      // HTTPS proxy its hostname must stay intact for the runtime's own TLS verification.
      const proxyIP = await resolvePublic(proxy.hostname);
      controller.signal.throwIfAborted();
      if (proxy.protocol === 'http') proxy.hostname = proxyIP;
      client = new dependencies.Client({
        connect: pinnedConnect, proxy: null, forceTunnel: true,
        trust: { mode: 'system' }, cookies: false, maxRedirects: 0,
        maxBodyBytes: MAX_BODY_BYTES, signal: controller.signal,
        timeouts: { connectMs: 15000, handshakeMs: 15000, headersMs: 15000, idleMs: 15000, totalMs: 0 },
      });
    })();
    await raceAbort(ready);
  }

  async function close(reason = new ApiError(502, 'UPSTREAM_CLOSED', 'The provider connection was closed.')) {
    if (closed) return;
    closed = true;
    controller.abort(reason);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const body of bodies) body.destroy(reason);
    const settled = Promise.allSettled([
      ...[...sockets].map(socket => Promise.resolve().then(() => socket.close())),
      Promise.resolve().then(() => client?.close()),
    ]);
    // A faulty peer must not keep a completed Durable Object request alive during teardown.
    let closeTimer;
    await Promise.race([settled, new Promise(resolve => { closeTimer = setTimeout(resolve, 1000); })]);
    clearTimeout(closeTimer);
    sockets.clear();
    pins.clear();
  }

  async function request(value, { hosts, headers = {}, timeout = 15000, redirects = 3 } = {}) {
    if (closed) throw new ApiError(502, 'UPSTREAM_CLOSED', 'The provider connection was closed.');
    let url = allowedURL(value, hosts);
    let remainingRedirects = Number.isInteger(redirects) && redirects >= 0 ? Math.min(redirects, 10) : 3;
    const duration = Number.isFinite(timeout) && timeout > 0 ? timeout : 15000;
    const timer = setTimeout(() => {
      void close(new ApiError(504, 'UPSTREAM_TIMEOUT', 'Upstream request timed out.'));
    }, duration);
    timers.add(timer);
    const cleanup = () => { clearTimeout(timer); timers.delete(timer); };
    let requestHeaders = new Headers(headers);
    // Proxy credentials belong exclusively to CONNECT, never to the origin request.
    requestHeaders.delete('proxy-authorization');
    requestHeaders.delete('host');
    try {
      await initialize();
      for (;;) {
        pins.set(url.hostname, await resolvePublic(url.hostname));
        const response = await raceAbort(client.fetch(url.href, { headers: requestHeaders, redirect: 'manual' }));
        if (REDIRECTS.has(response.status)) {
          await raceAbort(response.body?.cancel());
          if (!remainingRedirects-- || !response.headers.get('location')) throw new ApiError(502, 'UPSTREAM_REDIRECT', 'Invalid upstream redirect.');
          const next = allowedURL(new URL(response.headers.get('location'), url).href, hosts);
          if (next.origin !== url.origin) {
            requestHeaders = new Headers(requestHeaders);
            for (const name of CREDENTIALS) requestHeaders.delete(name);
          }
          url = next;
          continue;
        }
        const reader = response.body?.getReader();
        const body = reader ? Readable.fromWeb(new ReadableStream({
          async pull(output) {
            try {
              const part = await reader.read();
              if (part.done) output.close(); else output.enqueue(part.value);
            } catch (error) { output.error(safeError(error)); }
          },
          cancel: reason => reader.cancel(reason),
        })) : Readable.from([]);
        body.statusCode = response.status;
        body.headers = Object.fromEntries(response.headers);
        body.finalURL = url.href;
        bodies.add(body);
        const complete = () => { cleanup(); bodies.delete(body); };
        body.once('end', complete);
        body.once('close', complete);
        body.once('error', complete);
        return body;
      }
    } catch (error) {
      cleanup();
      throw safeError(controller.signal.aborted ? controller.signal.reason : error);
    }
  }

  return { request, close };
}
