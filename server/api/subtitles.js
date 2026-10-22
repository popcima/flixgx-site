import { ApiError } from './errors.js';
import { assertHLS } from './hls.js';
import { readBody, requireOK } from './network.js';

// Observed provider subtitle playlists contain one complete WebVTT file.
// Segmented HLS subtitles still work via playlistUrl in HLS.js. Do not flatten
// arbitrary segments: timestamp maps and discontinuities need proper remuxing.
export function subtitleFileURL(text, baseURL) {
  assertHLS(text);
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const uris = lines.filter(line => line && !line.startsWith('#'));
  if (uris.length !== 1 || !lines.includes('#EXT-X-ENDLIST') || lines.some(line => /^#EXT-X-(KEY|MAP|BYTERANGE|DISCONTINUITY)(:|$)/.test(line))) {
    throw new ApiError(422, 'SUBTITLE_EXPORT_UNSUPPORTED', 'This subtitle track needs HLS playback. Use its playlistUrl instead of the WebVTT export.');
  }
  return new URL(uris[0], baseURL).href;
}

export async function fetchSubtitle(resource, session, hosts, upstream, trustManifestURL = () => {}) {
  if (!resource?.subtitle) throw new ApiError(404, 'SUBTITLE_NOT_FOUND', 'Unknown subtitle track.');
  async function read(url) {
    const response = await upstream(url, { hosts, headers: session.headers, timeout: 15000 });
    requireOK(response);
    const body = (await readBody(response)).toString('utf8').replace(/^\uFEFF/, '');
    return { body, url: response.finalURL };
  }
  let { body, url } = await read(resource.url);
  if (body.trimStart().startsWith('#EXTM3U')) {
    const file = subtitleFileURL(body, url); trustManifestURL(file);
    ({ body } = await read(file));
  }
  if (!/^WEBVTT(?:[ \t][^\r\n]*)?(?:\r?\n|$)/.test(body)) throw new ApiError(502, 'INVALID_SUBTITLE', 'Provider did not return a WebVTT subtitle file.');
  // A full-file export cannot apply a non-zero MPEG transport timestamp offset.
  if (/^X-TIMESTAMP-MAP=/m.test(body)) throw new ApiError(422, 'SUBTITLE_EXPORT_UNSUPPORTED', 'This track uses HLS timestamp mapping. Use its playlistUrl for correct synchronization.');
  return body;
}
