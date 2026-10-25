import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createApp } from './api/app.js';

const root = new URL('../', import.meta.url);
const pages = new Set(['index.html', 'movies.html', 'tv.html', 'search.html', 'app.html', 'admin.html', 'data.json', 'noirx-supabase.js']);
const assets = new Set(['catalog.js', 'catalog.css', 'ads.js', 'ads.css', 'player.js', 'player.css', 'details.js', 'details.css', 'home.js', 'home.css', 'app-page.css', 'app-preview.png', 'player-config.js', 'subtitle-preferences.js', 'vendor/hls.min.js', 'vendor/HLS-LICENSE.txt']);
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', png: 'image/png' };

export function createSite(config, dependencies = {}) {
  // The public playback route serves this anonymous streaming website. The
  // wider /v1 API still needs a server-side key; no secret is sent to browsers.
  const apiKey = config.apiKey || randomBytes(32).toString('hex');
  const api = createApp({ ...config, apiKey }, dependencies);
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (/^\/api\/playback\/(?:movie\/[^/]+|tv\/[^/]+\/[^/]+\/[^/]+)$/.test(url.pathname)) {
      req.url = url.pathname.replace('/api/playback/', '/v1/streams/') + url.search;
      req.headers.authorization = `Bearer ${apiKey}`;
      api.emit('request', req, res); return;
    }
    if (url.pathname.startsWith('/v1/') || url.pathname === '/health') { api.emit('request', req, res); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cache-Control', 'no-cache');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!pages.has(path) && !(path.startsWith('assets/') && assets.has(path.slice(7)))) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
    }
    try {
      const content = await readFile(new URL(path, root));
      res.writeHead(200, { 'Content-Type': types[path.split('.').at(-1)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { res.writeHead(500); res.end('Unable to load this page.'); }
  });
}
