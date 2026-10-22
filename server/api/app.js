import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from './errors.js';
import { validateTarget, MEDIA_HOSTS, resolveProvider } from './provider.js';
import { SessionStore, Resolver } from './sessions.js';
import { request, requireOK, readBody } from './network.js';
import { rewriteManifest, m3uPlaylist } from './hls.js';
import { tmdb } from './tmdb.js';
import { fetchSubtitle } from './subtitles.js';

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function keyMatches(provided, expected) {
  const a = Buffer.from(provided || ''), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(config, { provider = resolveProvider, upstream = request, tmdbClient = tmdb } = {}) {
  const hosts = [...MEDIA_HOSTS, ...(config.extraHosts || [])];
  const store = new SessionStore(hosts), resolver = new Resolver(provider, store, config.baseURL);
  const rates = new Map(); let activeMedia = 0;
  function rateLimit(req) {
    const now = Date.now(), ip = req.socket.remoteAddress;
    for (const [key, value] of rates) if (value.reset <= now) rates.delete(key);
    if (!rates.has(ip)) {
      if (rates.size >= 4096) throw new ApiError(429, 'RATE_LIMITED', 'Server is busy; retry later.');
      rates.set(ip, { count: 0, reset: now + 60000 });
    }
    if (++rates.get(ip).count > 60) throw new ApiError(429, 'RATE_LIMITED', 'Limit is 60 API requests per minute per connection IP.');
  }
  async function media(req, res, sessionId, resourceId) {
    const session = store.get(sessionId), resource = session.resources.get(resourceId);
    if (!resource) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Unknown playback resource.');
    if (activeMedia >= 24) throw new ApiError(503, 'MEDIA_BUSY', 'Too many simultaneous media requests.');
    activeMedia++;
    let response;
    try {
      const headers = { ...session.headers };
      if (req.headers.range && !resource.manifest) {
        if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(req.headers.range)) throw new ApiError(416, 'INVALID_RANGE', 'Use a single valid byte range.');
        headers.Range = req.headers.range;
      }
      response = await upstream(resource.url, { hosts: session.hosts, headers, timeout: 25000 });
      if (response.statusCode === 416) { response.resume(); res.writeHead(416); res.end(); return; }
      requireOK(response);
      if (resource.manifest || /mpegurl/i.test(response.headers['content-type'] || '')) {
        const text = (await readBody(response)).toString();
        const body = rewriteManifest(text, response.finalURL, (url, manifest) => store.register(session, url, manifest, config.baseURL, { fromManifest: true }));
        return send(res, 200, body, 'application/vnd.apple.mpegurl');
      }
      const max = 32 * 1024 * 1024;
      if (Number(response.headers['content-length']) > max) throw new ApiError(502, 'SEGMENT_TOO_LARGE', 'Media segment exceeded 32 MiB.');
      const out = { 'Content-Type': /\.vtt(?:\?|$)/.test(resource.url) ? 'text/vtt' : 'application/octet-stream' };
      for (const name of ['content-range', 'accept-ranges', 'content-length']) if (response.headers[name]) out[name] = response.headers[name];
      res.writeHead(response.statusCode, out);
      let count = 0;
      const limit = new Transform({ transform(chunk, encoding, done) { count += chunk.length; done(count > max ? new Error('Segment limit exceeded') : null, chunk); } });
      await pipeline(response, limit, res);
    } finally { response?.destroy(); activeMedia--; }
  }
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Vary', 'Origin');
    try {
      const url = new URL(req.url, 'http://localhost'), origin = req.headers.origin;
      if (origin) {
        const permitted = origin === new URL(config.baseURL).origin || config.corsOrigins?.includes(origin);
        if (!permitted) throw new ApiError(403, 'ORIGIN_DENIED', 'Configure this website origin in CORS_ORIGINS.');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET.'); }
      if (url.pathname === '/health') return send(res, 200, { ok: true, provider: 'vidpro', tmdbConfigured: Boolean(config.tmdbToken) });
      const subtitleMatch = url.pathname.match(/^\/v1\/subtitles\/([a-f0-9]{48})\/([a-f0-9]{24})\.vtt$/);
      if (subtitleMatch) {
        const session = store.get(subtitleMatch[1]), resource = session.resources.get(subtitleMatch[2]);
        if (activeMedia >= 24) throw new ApiError(503, 'MEDIA_BUSY', 'Too many simultaneous media requests.');
        activeMedia++;
        try {
          const body = await fetchSubtitle(resource, session, session.hosts, upstream, url => store.trustManifestURL(session, url));
          if (url.searchParams.get('download') === '1') res.setHeader('Content-Disposition', 'attachment; filename="subtitles.vtt"');
          return send(res, 200, body, 'text/vtt; charset=utf-8');
        } finally { activeMedia--; }
      }
      const mediaMatch = url.pathname.match(/^\/v1\/media\/([a-f0-9]{48})\/([a-f0-9]{24})(?:\.m3u8)?$/);
      if (mediaMatch) return await media(req, res, mediaMatch[1], mediaMatch[2]);
      if (!url.pathname.startsWith('/v1/')) throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
      if (config.apiKey && !keyMatches(req.headers.authorization, `Bearer ${config.apiKey}`)) throw new ApiError(401, 'UNAUTHORIZED', 'Use Authorization: Bearer <API_KEY> from your website backend.');
      rateLimit(req);
      const targetMatch = url.pathname.match(/^\/v1\/(streams|playlist)\/(movie|tv)\/([^/]+)(?:\/([^/]+)\/([^/]+))?$/);
      if (targetMatch) {
        let [, mode, type, id, season, episode] = targetMatch;
        if (mode === 'playlist') { if (type === 'movie') id = id.replace(/\.m3u$/, ''); else episode = episode?.replace(/\.m3u$/, ''); }
        if (type === 'movie' && season !== undefined) throw new ApiError(400, 'INVALID_TARGET', 'Movie requests do not accept season or episode.');
        const target = validateTarget(type, id, season, episode), result = await resolver.resolve(target, { refresh: url.searchParams.get('refresh') === '1' });
        if (mode === 'streams') return send(res, 200, result);
        const title = `${type} TMDB ${id}${type === 'tv' ? ` S${season} E${episode}` : ''}`;
        return send(res, 200, m3uPlaylist(title, result.sources[0].playbackUrl), 'audio/x-mpegurl');
      }
      if (url.pathname === '/v1/search') {
        const query = url.searchParams.get('query')?.trim(), type = url.searchParams.get('type') || 'movie', page = url.searchParams.get('page') || '1';
        if (!query || query.length > 200 || !['movie', 'tv'].includes(type) || !/^[1-9]\d{0,2}$/.test(page) || +page > 500) throw new ApiError(400, 'INVALID_SEARCH', 'Provide query (1–200 characters), type movie/tv, and page 1–500.');
        return send(res, 200, await tmdbClient(`search/${type}`, { query, page, include_adult: false }, config.tmdbToken));
      }
      const detail = url.pathname.match(/^\/v1\/tmdb\/(movie|tv)\/([1-9]\d{0,9})$/);
      if (detail) return send(res, 200, await tmdbClient(`${detail[1]}/${detail[2]}`, {}, config.tmdbToken));
      throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof ApiError ? error.status : 502;
      if (status === 429) res.setHeader('Retry-After', '60');
      send(res, status, { error: { code: error instanceof ApiError ? error.code : 'UPSTREAM_UNAVAILABLE',
        message: error instanceof ApiError ? error.message : 'An upstream request failed. Try again shortly.',
        ...(error instanceof ApiError && error.upstream ? { upstream: error.upstream } : {}) } });
    }
  });
}
