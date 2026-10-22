import https from 'node:https';
import dns from 'node:dns';
import ipaddr from 'ipaddr.js';
import { ApiError } from './errors.js';

export function isPublicAddress(value) {
  try { return ipaddr.process(value).range() === 'unicast'; } catch { return false; }
}

export function allowedURL(value, hosts) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError(502, 'UNSAFE_UPSTREAM', 'Invalid upstream URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new ApiError(502, 'UNSAFE_UPSTREAM', 'Upstream host is outside the configured provider allowlist.');
  }
  return url;
}

function publicLookup(host, options, callback) {
  dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) {
      return callback(new ApiError(502, 'UNSAFE_UPSTREAM', 'Upstream resolved to a non-public address.'));
    }
    if (options.all) return callback(null, addresses);
    const address = addresses.find(a => !options.family || a.family === options.family) || addresses[0];
    callback(null, address.address, address.family);
  });
}

// DNS is checked in the actual socket lookup, including every redirect.
export async function request(value, { hosts, headers = {}, timeout = 15000, redirects = 3 } = {}) {
  const url = allowedURL(value, hosts);
  const response = await new Promise((resolve, reject) => {
    const req = https.get(url, { headers, lookup: publicLookup }, resolve);
    const timer = setTimeout(() => req.destroy(new ApiError(504, 'UPSTREAM_TIMEOUT', 'Upstream request timed out.')), timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    if (!redirects || !response.headers.location) throw new ApiError(502, 'UPSTREAM_REDIRECT', 'Invalid upstream redirect.');
    const next = allowedURL(new URL(response.headers.location, url).href, hosts);
    const nextHeaders = { ...headers };
    if (next.origin !== url.origin) { delete nextHeaders.Authorization; delete nextHeaders.Cookie; }
    return request(next.href, { hosts, headers: nextHeaders, timeout, redirects: redirects - 1 });
  }
  response.finalURL = url.href;
  return response;
}

export async function readBody(response, limit = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > limit) { response.destroy(); throw new ApiError(502, 'UPSTREAM_TOO_LARGE', 'Upstream response exceeded the size limit.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function requireOK(response) {
  if (response.statusCode >= 200 && response.statusCode < 300) return;
  response.resume();
  const status = response.statusCode;
  if (status === 404) throw new ApiError(404, 'SOURCE_NOT_FOUND', 'This title or episode is unavailable from the provider.');
  if (status === 401 || status === 403) throw new ApiError(502, 'PROVIDER_DENIED', 'The provider denied this request. Resolve again or try later.');
  throw new ApiError(502, 'UPSTREAM_ERROR', `The provider returned HTTP ${status}.`);
}
