import 'dotenv/config';
import { createSite } from './site.js';
import { configureUpstreamProxy } from './api/network.js';

configureUpstreamProxy(process.env.UPSTREAM_PROXY_URL || '');

const port = Number(process.env.PORT || 8788), host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const baseURL = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, '');
const parsed = new URL(baseURL);
if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('PUBLIC_BASE_URL must be an HTTP(S) origin without a path.');
const split = key => (process.env[key] || '').split(',').map(x => x.trim()).filter(Boolean);
const server = createSite({ baseURL, apiKey: process.env.API_KEY || '', tmdbToken: process.env.TMDB_READ_TOKEN || '', corsOrigins: split('CORS_ORIGINS'), extraHosts: split('EXTRA_MEDIA_HOSTS') });
server.listen(port, host, () => console.log(`FlixGX site and playback API: ${baseURL} (listening on ${host}:${port})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 5000).unref(); });
