import { ApiError } from './errors.js';

export function assertHLS(text) {
  if (!text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) {
    throw new ApiError(502, 'INVALID_MANIFEST', 'Provider returned something other than an HLS playlist.');
  }
}

export function attributes(line) {
  const result = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,\r\n]*))/g)) result[m[1]] = m[2] ?? m[3];
  return result;
}

export function inspectManifest(text, baseURL) {
  assertHLS(text);
  const qualities = [], audioTracks = [], subtitles = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim(), attr = attributes(line);
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const track = { name: attr.NAME, language: attr.LANGUAGE, default: attr.DEFAULT === 'YES', forced: attr.FORCED === 'YES',
        ...(attr.URI ? { url: new URL(attr.URI, baseURL).href } : {}) };
      if (attr.TYPE === 'AUDIO') audioTracks.push(track);
      if (attr.TYPE === 'SUBTITLES') subtitles.push(track);
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const uri = lines.slice(i + 1).find(v => v.trim() && !v.startsWith('#'));
      qualities.push({ resolution: attr.RESOLUTION, bandwidth: Number(attr.BANDWIDTH), codecs: attr.CODECS,
        url: uri ? new URL(uri.trim(), baseURL).href : undefined });
    }
  }
  return { qualities, audioTracks, subtitles };
}

// Rewrite both bare URIs and URI attributes: variants, audio, subtitles, keys,
// initialization segments and partial segments all stay on this server.
export function rewriteManifest(text, baseURL, register) {
  assertHLS(text);
  let nextIsManifest = false;
  return text.split(/\r?\n/).map(raw => {
    const line = raw.trim();
    if (!line) return raw;
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) nextIsManifest = true;
      const manifest = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT):/.test(line);
      return raw.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${register(new URL(uri, baseURL).href, manifest)}"`);
    }
    const replacement = register(new URL(line, baseURL).href, nextIsManifest);
    nextIsManifest = false;
    return replacement;
  }).join('\n');
}

export function m3uPlaylist(title, url) {
  return `#EXTM3U\n#EXTINF:-1,${title.replace(/[\r\n]/g, ' ')}\n${url}\n`;
}
