import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
const origin = (process.env.STREAM_API_ORIGIN || '').replace(/\/$/, '');
if (origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('STREAM_API_ORIGIN must be a full HTTPS origin without a path.');
}
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'movies.html', 'tv.html', 'search.html', 'admin.html', 'data.json', 'noirx-supabase.js', 'CNAME', 'assets']) await cp(file, `dist/${file}`, { recursive: true });
if (origin) await writeFile('dist/assets/player-config.js', `window.FLIXGX_PLAYER = ${JSON.stringify({ apiBaseUrl: origin })};\n`);
else console.warn('Set STREAM_API_ORIGIN or edit assets/player-config.js before publishing on GitHub Pages.');
