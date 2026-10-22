import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { subtitleFileURL, fetchSubtitle } from '../../server/api/subtitles.js';
import { chooseSubtitle, readPreference, savePreference } from '../../assets/subtitle-preferences.js';

test('selects English by default, remembers languages and preserves Off', () => {
  const tracks = [
    { name: 'Italian [Forced]', language: 'ita', forced: true },
    { name: 'English [CC]', language: 'eng' },
    { name: 'French', language: 'fre' },
  ];
  assert.equal(chooseSubtitle(tracks, null), 1);
  assert.equal(chooseSubtitle(tracks, 'off'), -1);
  assert.equal(chooseSubtitle(tracks, { name: 'French', language: 'fre' }), 2);
  assert.equal(chooseSubtitle(tracks, { name: 'French [CC]', language: 'fre' }), 2);
  assert.equal(chooseSubtitle(tracks, { name: 'Arabic', language: 'ara' }), -1);
  assert.equal(chooseSubtitle([], null), -1);
  assert.equal(chooseSubtitle([{ name: 'English', language: 'en' }], null), 0);
  const storage = { getItem: () => storage.value, setItem: (_, value) => { storage.value = value; } };
  savePreference(storage, tracks[2]); assert.deepEqual(readPreference(storage), { name: 'French', language: 'fre' });
  savePreference(storage, null); assert.equal(readPreference(storage), 'off');
  storage.value = '{invalid'; assert.equal(readPreference(storage), null);
});

test('WebVTT exports preserve cue timing and reject unsupported flattening', async () => {
  const playlist = '#EXTM3U\n#EXTINF:120,\n../english.vtt?token=fixture\n#EXT-X-ENDLIST\n';
  assert.equal(subtitleFileURL(playlist, 'https://vixsrc.to/playlist/1'), 'https://vixsrc.to/english.vtt?token=fixture');
  for (const text of [playlist.replace('../english', 'second.vtt\n../english'), playlist.replace('#EXT-X-ENDLIST', ''), playlist.replace('#EXTINF', '#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF')]) {
    assert.throws(() => subtitleFileURL(text, 'https://vixsrc.to/playlist/1'), { code: 'SUBTITLE_EXPORT_UNSUPPORTED' });
  }
  const vtt = 'WEBVTT\n\n00:00.500 --> 00:02.000\nTest caption.\n', calls = [];
  const upstream = async (url, options) => {
    calls.push({ url, options }); const response = Readable.from([Buffer.from(url.endsWith('/track') ? playlist : vtt)]);
    response.statusCode = 200; response.finalURL = url; return response;
  };
  const session = { headers: { Referer: 'https://vixsrc.to/embed/fixture' } };
  assert.equal(await fetchSubtitle({ url: 'https://vixsrc.to/track', subtitle: true }, session, ['vixsrc.to'], upstream), vtt);
  assert.equal(calls.length, 2); assert.equal(calls[1].options.headers.Referer, session.headers.Referer);
  await assert.rejects(fetchSubtitle({ url: 'https://vixsrc.to/master' }, session, ['vixsrc.to'], upstream), { code: 'SUBTITLE_NOT_FOUND' });
});

test('WebVTT export rejects HTML and transport timestamp mapping', async () => {
  for (const [body, code] of [['<html>provider error</html>', 'INVALID_SUBTITLE'], ['WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n', 'SUBTITLE_EXPORT_UNSUPPORTED']]) {
    const upstream = async () => { const r = Readable.from([Buffer.from(body)]); r.statusCode = 200; r.finalURL = 'https://vixsrc.to/sub.vtt'; return r; };
    await assert.rejects(fetchSubtitle({ subtitle: true, url: 'https://vixsrc.to/sub.vtt' }, { headers: {} }, ['vixsrc.to'], upstream), { code });
  }
});
