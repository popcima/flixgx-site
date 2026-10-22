import test from 'node:test';
import assert from 'node:assert/strict';
import { createSite } from '../server/site.js';

test('site serves the real player, hides private files, and routes movie/TV playback with CORS', async t => {
  const targets = [];
  const server = createSite({ baseURL: 'https://api.example', apiKey: 'server-only', corsOrigins: ['https://flixgx.com'] }, {
    provider: async target => {
      targets.push(target);
      return { url: 'https://vixsrc.to/master', headers: {}, expiresAt: Date.now() + 600000, qualities: [], audioTracks: [], subtitles: [] };
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const page of ['/', '/movies.html', '/tv.html', '/search.html']) {
    const response = await fetch(base + page), html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /assets\/player.js/); assert.match(html, /id="fp-video"/);
    assert.doesNotMatch(html, /content-locker|ADBLUE|__fpPause|FAKE PLAYER/);
  }
  for (const path of ['/.env', '/server/index.js', '/package.json', '/assets/../server/site.js', '/content-locker/adblue-config.js']) assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await fetch(base + '/v1/streams/movie/98')).status, 401);
  const movie = await fetch(base + '/api/playback/movie/98', { headers: { Origin: 'https://flixgx.com' } });
  assert.equal(movie.status, 200); assert.equal(movie.headers.get('access-control-allow-origin'), 'https://flixgx.com');
  assert.match((await movie.json()).sources[0].playbackUrl, /^https:\/\/api.example\/v1\/media\//);
  assert.equal((await fetch(base + '/api/playback/tv/1396/2/3')).status, 200);
  assert.equal(targets[1].season, 2); assert.equal(targets[1].episode, 3);
  assert.equal((await fetch(base + '/api/playback/movie/0')).status, 400);
  assert.equal((await fetch(base + '/api/playback/movie/98', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/playback/movie/98', { method: 'OPTIONS', headers: { Origin: 'https://flixgx.com' } })).status, 204);
});
