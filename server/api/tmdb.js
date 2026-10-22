import { request, readBody } from './network.js';
import { ApiError } from './errors.js';

export async function tmdb(path, params, token) {
  if (!token) throw new ApiError(503, 'TMDB_NOT_CONFIGURED', 'Set your TMDB_READ_TOKEN on the server to enable metadata and search. Resolving known TMDB IDs works without it.');
  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await request(url.href, { hosts: ['api.themoviedb.org'], headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (response.statusCode !== 200) {
    response.resume();
    throw new ApiError(response.statusCode === 404 ? 404 : 502, 'TMDB_ERROR', `TMDB returned HTTP ${response.statusCode}.`);
  }
  return JSON.parse((await readBody(response)).toString());
}
