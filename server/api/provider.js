import { request, readBody, requireOK, allowedURL } from './network.js';
import { ApiError } from './errors.js';
import { inspectManifest } from './hls.js';

export const PROVIDER_HOSTS = ['vixsrc.to'];
export const MEDIA_HOSTS = ['vixsrc.to', 'youngbridge89.boats', 'frozenlagoon85.boats', 'vix-content.net'];
const CLIENT_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; FlixGX/1.0)', 'Accept-Language': 'en-US,en;q=0.9' };

function checkProviderResponse(response, stage, target) {
  try { requireOK(response); } catch (error) {
    // Safe diagnostics remain available when the hosting platform's logs are down.
    // Never include signed URLs, response bodies, cookies or authorization headers.
    const upstream = { stage, status: response.statusCode, challenge: response.headers?.['cf-mitigated'] === 'challenge' };
    console.warn(JSON.stringify({ event: 'provider_request_failed', ...upstream, ...target }));
    if (error instanceof ApiError) error.upstream = upstream;
    throw error;
  }
}

export function validateTarget(type, id, season, episode) {
  if (!['movie', 'tv'].includes(type) || !/^[1-9]\d{0,9}$/.test(String(id))) {
    throw new ApiError(400, 'INVALID_TARGET', 'Use movie or tv with a positive numeric TMDB ID.');
  }
  if (type === 'tv' && (!/^\d{1,4}$/.test(String(season)) || !/^[1-9]\d{0,3}$/.test(String(episode)))) {
    throw new ApiError(400, 'INVALID_EPISODE', 'TV needs season (0 or greater) and episode (1 or greater).');
  }
  return { type, tmdbId: Number(id), ...(type === 'tv' ? { season: Number(season), episode: Number(episode) } : {}) };
}

export function parsePlayer(html) {
  const block = html.match(/window\.masterPlaylist\s*=\s*\{\s*params\s*:\s*\{([\s\S]*?)\}\s*,\s*url\s*:\s*(['"])([^'"\r\n]+)\2/);
  if (!block) throw new ApiError(502, 'PROVIDER_CHANGED', 'Provider player format changed; update the provider adapter.');
  const params = new Map([...block[1].matchAll(/['"]([a-zA-Z0-9_]+)['"]\s*:\s*['"]([^'"\r\n]*)['"]/g)].map(m => [m[1], m[2]]));
  if (!params.get('token') || !/^\d{10,13}$/.test(params.get('expires') || '')) {
    throw new ApiError(502, 'PROVIDER_CHANGED', 'Provider playlist token or expiry is missing.');
  }
  const url = allowedURL(block[3].replace(/\\\//g, '/'), PROVIDER_HOSTS);
  for (const [key, value] of params) if (value) url.searchParams.set(key, value);
  if (/window\.canPlayFHD\s*=\s*true/.test(html)) url.searchParams.set('h', '1');
  url.searchParams.set('lang', 'en');
  return { url: url.href, expiresAt: Number(params.get('expires')) * 1000 };
}

export async function resolveProvider(target, { upstream = request } = {}) {
  const path = target.type === 'movie' ? `movie/${target.tmdbId}` : `tv/${target.tmdbId}/${target.season}/${target.episode}`;
  const pageURL = `https://vixsrc.to/${path}`;
  const api = await upstream(`https://vixsrc.to/api/${path}`, { hosts: PROVIDER_HOSTS, headers: { ...CLIENT_HEADERS, Referer: pageURL, Accept: 'application/json' } });
  checkProviderResponse(api, 'source_lookup', target);
  let data;
  try { data = JSON.parse((await readBody(api)).toString()); } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'INVALID_PROVIDER_RESPONSE', 'Provider did not return a JSON response.');
  }
  if (typeof data.src !== 'string') throw new ApiError(404, 'SOURCE_NOT_FOUND', 'Provider has no source for this title or episode.');
  const embed = allowedURL(new URL(data.src, pageURL).href, PROVIDER_HOSTS).href;
  const player = await upstream(embed, { hosts: PROVIDER_HOSTS, headers: { ...CLIENT_HEADERS, Referer: pageURL, Accept: 'text/html' } });
  checkProviderResponse(player, 'player_configuration', target);
  const parsed = parsePlayer((await readBody(player)).toString());
  if (parsed.expiresAt <= Date.now() + 60000) throw new ApiError(502, 'EXPIRED_SOURCE', 'Provider returned an expired stream; try again.');
  const headers = { ...CLIENT_HEADERS, Referer: embed, Origin: 'https://vixsrc.to' };
  const master = await upstream(parsed.url, { hosts: PROVIDER_HOSTS, headers });
  checkProviderResponse(master, 'master_playlist', target);
  const manifest = (await readBody(master)).toString();
  return { ...parsed, url: master.finalURL, manifest, headers, pageURL, ...inspectManifest(manifest, master.finalURL) };
}
