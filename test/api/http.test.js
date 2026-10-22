import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from '../../server/api/app.js';

test('HTTP API: authenticated resolution, CORS, M3U, complete HLS relay, ranges and failures', async t => {
  const calls = [];
  const provider = async target => ({ url: 'https://vixsrc.to/master', headers: { Referer: 'https://vixsrc.to/embed/fixture' }, pageURL: 'https://vixsrc.to/movie/1',
    expiresAt: Date.now() + 3600000, qualities: [{ resolution: '1280x720' }], audioTracks: [],
    subtitles: [{ name: 'English', language: 'eng', url: 'https://vixsrc.to/subs' }] });
  const upstream = async (url, options) => {
    calls.push({ url, options }); let body, contentType = 'application/vnd.apple.mpegurl';
    if (url.endsWith('/master')) body = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="/audio"\n#EXT-X-STREAM-INF:BANDWIDTH=200\n/variant\n';
    else if (url.endsWith('/variant') || url.endsWith('/audio')) body = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:4,\nhttps://cdn-fixture.example/segment\n#EXT-X-ENDLIST\n';
    else if (url.endsWith('/subs')) body = '#EXTM3U\n#EXTINF:10,\nhttps://captions-fixture.example/english.vtt\n#EXT-X-ENDLIST\n';
    else if (url.endsWith('.vtt')) { body = 'WEBVTT\n\n00:00.000 --> 00:02.000\nTest caption.\n'; contentType = 'text/vtt'; }
    else { body = Buffer.from([0, 1, 2, 3]); contentType = 'application/octet-stream'; }
    const response = Readable.from([Buffer.from(body)]); response.statusCode = options.headers.Range ? 206 : 200;
    response.headers = { 'content-type': contentType, ...(options.headers.Range ? { 'content-range': 'bytes 0-3/100' } : {}) };
    response.finalURL = url; return response;
  };
  const config = { baseURL: 'https://api.example', apiKey: 'test-only-key', corsOrigins: ['https://site.example'], extraHosts: [] };
  const server = createApp(config, { provider, upstream });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: 'Bearer test-only-key' };
  const get = (path, headers = {}) => fetch(base + (path.startsWith('https:') ? new URL(path).pathname + new URL(path).search : path), { headers });
  assert.equal((await get('/health')).status, 200);
  assert.equal((await get('/v1/streams/movie/1')).status, 401);
  assert.equal((await get('/v1/streams/movie/0', auth)).status, 400);
  assert.equal((await get('/v1/streams/tv/1396', auth)).status, 400);
  assert.equal((await get('/v1/streams/movie/1/2/3', auth)).status, 400);
  assert.equal((await get('/v1/streams/movie/1', { ...auth, Origin: 'https://evil.example' })).status, 403);
  const resolved = await get('/v1/streams/movie/1', { ...auth, Origin: 'https://site.example' });
  assert.equal(resolved.headers.get('access-control-allow-origin'), 'https://site.example');
  const json = await resolved.json(); assert.equal(json.provider, 'vidpro');
  const subtitle = json.sources[0].subtitles[0];
  assert.equal(subtitle.format, 'hls'); assert.ok(subtitle.playlistUrl.includes('/v1/media/'));
  const vtt = await get(subtitle.vttUrl + '?download=1');
  assert.equal(vtt.status, 200); assert.match(vtt.headers.get('content-type'), /^text\/vtt/);
  assert.match(vtt.headers.get('content-disposition'), /attachment/); assert.ok((await vtt.text()).startsWith('WEBVTT'));
  const notSubtitle = json.sources[0].playbackUrl.replace('/v1/media/', '/v1/subtitles/').replace('.m3u8', '.vtt');
  assert.equal((await get(notSubtitle)).status, 404);
  const master = await (await get(json.sources[0].playbackUrl)).text();
  assert.ok(master.startsWith('#EXTM3U')); assert.ok(!master.includes('https://vixsrc.to'));
  const variantURL = master.split('\n').find(x => x.startsWith('https:'));
  const variant = await (await get(variantURL)).text();
  const segmentURL = variant.split('\n').find(x => x.startsWith('https:'));
  const keyURL = variant.match(/URI="([^"]+)"/)[1];
  assert.deepEqual(new Uint8Array(await (await get(keyURL)).arrayBuffer()), new Uint8Array([0, 1, 2, 3]));
  const segment = await get(segmentURL, { Range: 'bytes=0-3' }); assert.equal(segment.status, 206);
  assert.equal(segment.headers.get('content-range'), 'bytes 0-3/100'); await segment.arrayBuffer();
  assert.equal(calls.at(-1).options.headers.Range, 'bytes=0-3');
  assert(calls.at(-1).options.hosts.includes('cdn-fixture.example'));
  assert(calls.some(c => c.url === 'https://captions-fixture.example/english.vtt' && c.options.hosts.includes('captions-fixture.example')));
  assert.equal(calls.at(-1).options.headers.Referer, 'https://vixsrc.to/embed/fixture');
  assert.equal((await get(segmentURL, { Range: 'bytes=0-1,4-5' })).status, 416);
  const m3u = await (await get('/v1/playlist/tv/1396/1/1.m3u', auth)).text(); assert.ok(m3u.startsWith('#EXTM3U')); assert.ok(m3u.includes('/v1/media/'));
  const unknown = json.sources[0].playbackUrl.replace(/\/([a-f0-9]{24})\.m3u8$/, '/000000000000000000000000.m3u8');
  assert.equal((await get(unknown)).status, 404);
  assert.equal((await get('/v1/search?query=test', auth)).status, 503);
  assert.equal((await get('/v1/search?query=test&page=501', auth)).status, 400);
});
