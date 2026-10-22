import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createSite } from '../server/site.js';

// A temporary preview of both the site and API. Nothing is deployed to Workers,
// and no temporary hostname is saved into the production player configuration.
let site, tunnel, stopping = false;
const server = createServer((req, res) => {
  if (site) return site.emit('request', req, res);
  res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '2' });
  res.end('The test preview is starting.');
});

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupTimeout);
  tunnel?.kill('SIGTERM');
  server.closeAllConnections();
  server.close();
  process.exitCode = code;
  // Also stop a child that does not respond to SIGTERM.
  setTimeout(() => { tunnel?.kill('SIGKILL'); process.exit(code); }, 3000).unref();
}

const startupTimeout = setTimeout(() => {
  console.error('Cloudflare did not provide a test URL within 60 seconds. Retry later.');
  stop(1);
}, 60000);
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
server.once('error', error => { console.error(error.message); stop(1); });

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  tunnel = spawn(process.env.CLOUDFLARED_BIN || 'cloudflared', [
    'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnel.once('error', error => {
    console.error(error.code === 'ENOENT'
      ? 'Install cloudflared first: https://developers.cloudflare.com/tunnel/downloads/'
      : error.message);
    stop(1);
  });
  tunnel.once('exit', code => {
    if (!stopping) { console.error(`The Cloudflare test tunnel stopped (exit ${code}).`); stop(1); }
  });
  let output = '';
  const observe = chunk => {
    process.stderr.write(chunk);
    output = (output + chunk.toString()).slice(-16384);
    if (site || stopping) return;
    const origin = output.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/)?.[0];
    if (!origin) return;
    const split = key => (process.env[key] || '').split(',').map(s => s.trim()).filter(Boolean);
    site = createSite({
      baseURL: origin,
      apiKey: process.env.API_KEY || '',
      tmdbToken: process.env.TMDB_READ_TOKEN || '',
      corsOrigins: [...new Set(['http://localhost:8788', 'http://127.0.0.1:8788', ...split('CORS_ORIGINS')])],
      extraHosts: split('EXTRA_MEDIA_HOSTS'),
    });
    clearTimeout(startupTimeout);
    console.log(`\nFlixGX temporary test preview: ${origin}\nAPI health check: ${origin}/health\nKeep this process and your Mac running. Press Ctrl+C to stop.\nThe URL is public and changes on restart. Production settings are unchanged.\n`);
  };
  tunnel.stdout.on('data', observe);
  tunnel.stderr.on('data', observe);
});
