import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlayer, validateTarget } from '../../server/api/provider.js';
import { rewriteManifest, inspectManifest, m3uPlaylist } from '../../server/api/hls.js';
import { allowedURL, isPublicAddress } from '../../server/api/network.js';
import { SessionStore, Resolver } from '../../server/api/sessions.js';

const player = `window.masterPlaylist = { params: { 'token': 'fixture-token', 'expires': '1900000000', 'asn': '', }, url: 'https://vixsrc.to/playlist/1', }; window.canPlayFHD = true;`;
test('extracts fresh configuration as data, without executing the page', () => {
  const value = parsePlayer(player + 'globalThis.PWNED = true;');
  assert.equal(new URL(value.url).searchParams.get('token'), 'fixture-token');
  assert.equal(new URL(value.url).searchParams.get('h'), '1');
  assert.equal(globalThis.PWNED, undefined);
  assert.throws(() => parsePlayer('<html>Challenge</html>'), { code: 'PROVIDER_CHANGED' });
  assert.throws(() => parsePlayer(player.replace('vixsrc.to', 'localhost')), { code: 'UNSAFE_UPSTREAM' });
});
test('validates IDs and episodes, including season zero', () => {
  assert.equal(validateTarget('tv', '1396', '0', '1').season, 0);
  for (const id of ['0', '-1', '12abc', '1/../../', '1e3']) assert.throws(() => validateTarget('movie', id));
  assert.throws(() => validateTarget('tv', '1396', '1', '0'));
  assert.throws(() => validateTarget('tv', '1396'));
});
test('rewrites variants, audio, subtitles, keys, maps and segments, preserving signed queries', () => {
  const items = [];
  const text = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,NAME="English, main",URI="audio?token=abc&x=1"\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="/subs"\n#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1,mp4a",RESOLUTION=1280x720\nvideo?sig=xyz\n';
  const rewritten = rewriteManifest(text, 'https://vixsrc.to/playlist/master?token=x', (url, manifest) => { items.push({ url, manifest }); return `/relay/${items.length}`; });
  assert.equal(items.length, 3); assert.ok(items.every(x => x.manifest));
  assert.equal(items[0].url, 'https://vixsrc.to/playlist/audio?token=abc&x=1');
  assert.ok(rewritten.includes('URI="/relay/1"')); assert.ok(rewritten.includes('\n/relay/3\n'));
  const info = inspectManifest(text, 'https://vixsrc.to/playlist/master');
  assert.equal(info.qualities[0].resolution, '1280x720'); assert.equal(info.audioTracks[0].name, 'English, main');
  assert.equal(info.subtitles[0].url, 'https://vixsrc.to/subs');
  const resources = [];
  rewriteManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg.html?x=1\n', 'https://vixsrc.to/playlist/master', (url, manifest) => { resources.push({ url, manifest }); return url; });
  assert.equal(resources.length, 3); assert.ok(resources.every(x => !x.manifest));
  assert.throws(() => rewriteManifest('<html>error</html>', '', () => ''), { code: 'INVALID_MANIFEST' });
});
test('blocks private IPs, credentials, unsafe schemes and host suffix tricks', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  for (const url of ['http://vixsrc.to/a', 'https://vixsrc.to.evil.test/a', 'https://u:p@vixsrc.to/a', 'https://vixsrc.to:444/a']) assert.throws(() => allowedURL(url, ['vixsrc.to']));
});
test('session expiry, deduplication, and bounded capacity', () => {
  const store = new SessionStore(['vixsrc.to'], { maxSessions: 1 });
  const source = { headers: {}, expiresAt: Date.now() + 3600000 };
  const session = store.create(source), a = store.register(session, 'https://vixsrc.to/a', true, 'https://api.test');
  assert.equal(store.register(session, 'https://vixsrc.to/a', true, 'https://api.test'), a);
  assert.throws(() => store.create(source), { code: 'SESSION_LIMIT' });
  session.expiresAt = Date.now() - 1;
  assert.throws(() => store.get(session.id), { code: 'SESSION_EXPIRED' });
});
test('deduplicates concurrent resolutions and caches only live sessions', async () => {
  let calls = 0;
  const store = new SessionStore(['vixsrc.to']);
  const resolver = new Resolver(async () => { calls++; return { url: 'https://vixsrc.to/master', headers: {}, expiresAt: Date.now() + 3600000 }; }, store, 'https://api.test');
  const [a, b] = await Promise.all([resolver.resolve({ type: 'movie', tmdbId: 1 }), resolver.resolve({ type: 'movie', tmdbId: 1 })]);
  assert.equal(calls, 1); assert.equal(a, b);
  await resolver.resolve({ type: 'movie', tmdbId: 1 }); assert.equal(calls, 1);
  store.sessions.clear(); await resolver.resolve({ type: 'movie', tmdbId: 1 }); assert.equal(calls, 2);
});
test('M3U contains a stream URL and sanitizes title newlines', () => {
  assert.equal(m3uPlaylist('Title\nInjected', 'https://api.test/master'), '#EXTM3U\n#EXTINF:-1,Title Injected\nhttps://api.test/master\n');
});

test('CDN discovery is scoped to verified playlist resources and individual sessions', () => {
  const store = new SessionStore(['vixsrc.to']);
  const source = { headers: {}, expiresAt: Date.now() + 3600000 };
  const a = store.create(source), b = store.create(source);
  const resource = 'https://new-cdn.example/segment.ts';
  assert.throws(() => store.register(a, resource, false, 'https://api.test'), { code: 'UNSAFE_UPSTREAM' });
  store.register(a, resource, false, 'https://api.test', { fromManifest: true });
  assert(a.hosts.includes('new-cdn.example'));
  assert.throws(() => store.register(b, resource, false, 'https://api.test'), { code: 'UNSAFE_UPSTREAM' });
  for (const url of ['http://new-cdn.example/a', 'https://user:pass@new-cdn.example/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://169.254.169.254/a', 'https://localhost/a', 'https://example.com:8443/a']) {
    assert.throws(() => store.trustManifestURL(a, url), { code: 'UNSAFE_UPSTREAM' });
  }
  while (a.hosts.length < 64) store.trustManifestURL(a, `https://cdn${a.hosts.length}.example/a`);
  assert.throws(() => store.trustManifestURL(a, 'https://another.example/a'), { code: 'HOST_LIMIT' });
});
