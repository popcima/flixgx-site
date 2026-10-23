import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { ManifestCache } from '../../server/api/manifest-cache.js';
import { SessionStore } from '../../server/api/sessions.js';
import { createApp } from '../../server/api/app.js';

const vod = '#EXTM3U\n#EXTINF:6,\n/segment\n#EXT-X-ENDLIST\n';
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200\n/variant\n';
test('playlist cache respects expiry, session bounds, byte/count limits, and excludes live playlists', () => {
  let now = 100;
  const cache = new ManifestCache({ maxBytes: vod.length * 2, maxEntries: 2, ttl: 50, now: () => now });
  cache.put('a', vod, 1000); cache.put('b', vod, 1000);
  assert.equal(cache.get('a'), vod);
  cache.put('c', vod, 1000);
  assert.equal(cache.get('b'), undefined); assert.equal(cache.get('a'), vod);
  assert.ok(cache.bytes <= vod.length * 2);
  now = 151; assert.equal(cache.get('a'), undefined);
  cache.put('expiry', vod, 160); now = 160;
  assert.equal(cache.get('expiry'), undefined);
  cache.put('live', vod.replace('#EXT-X-ENDLIST', ''), 1000);
  assert.equal(cache.get('live'), undefined);
  cache.put('large', vod.repeat(4), 1000); assert.equal(cache.get('large'), undefined);
});

test('resolved master is reused; VOD repeats avoid upstream and still enforce session expiry and CORS', async t => {
  const store = new SessionStore(['vixsrc.to']), calls = [];
  const provider = async () => ({ url: 'https://vixsrc.to/master', manifest: master, headers: {}, expiresAt: Date.now() + 600000 });
  const upstream = async url => {
    calls.push(url);
    const response = Readable.from([Buffer.from(vod)]);
    response.statusCode = 200; response.finalURL = url; response.headers = { 'content-type': 'application/vnd.apple.mpegurl' };
    return response;
  };
  const app = createApp({ baseURL: 'https://api.test', apiKey: 'fixture', corsOrigins: [] }, { store, provider, upstream });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.closeAllConnections(); app.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const get = (url, options) => fetch(base + new URL(url, base).pathname, options);
  const data = await (await get('/v1/streams/movie/98', { headers: { Authorization: 'Bearer fixture' } })).json();
  const playback = data.sources[0].playbackUrl;
  const result = await get(playback);
  assert.equal(result.headers.get('server-timing'), 'playlist_cache;desc="hit"');
  const text = await result.text();
  assert.equal(calls.length, 0); assert.ok(!text.includes('vixsrc.to'));
  const variant = text.split('\n').find(line => line.startsWith('https:'));
  await (await get(variant)).text(); await (await get(variant)).text();
  assert.equal(calls.length, 1);
  assert.equal((await get(playback, { headers: { Origin: 'https://untrusted.test' } })).status, 403);
  store.sessions.values().next().value.expiresAt = Date.now() - 1;
  assert.equal((await get(playback)).status, 410);
});
