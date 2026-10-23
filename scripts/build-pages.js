import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const origin = (process.env.STREAM_API_ORIGIN || '').replace(/\/$/, '');
if (origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('STREAM_API_ORIGIN must be a full HTTPS origin without a path.');
}
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'movies.html', 'tv.html', 'search.html', 'admin.html', 'data.json', 'noirx-supabase.js', 'CNAME', 'assets']) await cp(file, `dist/${file}`, { recursive: true });
if (origin) {
  const config = `window.FLIXGX_PLAYER = ${JSON.stringify({ apiBaseUrl: origin })};\n`;
  await writeFile('dist/assets/player-config.js', config);
}
else console.warn('Set STREAM_API_ORIGIN or edit assets/player-config.js before publishing on GitHub Pages.');
// Ship player fixes and API cutovers without reusing older cached scripts.
for (const asset of ['player-config.js', 'player.js']) {
  const version = createHash('sha256').update(await readFile(`dist/assets/${asset}`)).digest('hex').slice(0, 12);
  for (const page of ['index.html', 'movies.html', 'tv.html', 'search.html']) {
    const path = `dist/${page}`, html = await readFile(path, 'utf8');
    await writeFile(path, html.replace(`src="assets/${asset}"`, `src="assets/${asset}?v=${version}"`));
  }
}
