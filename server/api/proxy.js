import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import ipaddr from 'ipaddr.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ApiError } from './errors.js';

export function parseProxyURL(value) {
  let url;
  try { url = new URL(value); } catch { /* Never echo a URL containing credentials. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('UPSTREAM_PROXY_URL must be an HTTP(S) proxy origin, optionally with username and password.');
  }
  try { decodeURIComponent(url.username); decodeURIComponent(url.password); }
  catch { throw new Error('UPSTREAM_PROXY_URL contains invalid credential encoding.'); }
  return url;
}

// CONNECT uses the checked IP; TLS still authenticates the original hostname.
export class PublicProxyAgent extends HttpsProxyAgent {
  constructor(value, { lookupTarget, connectTimeout = 15000 } = {}) {
    super(parseProxyURL(value));
    this.lookupTarget = lookupTarget;
    this.connectTimeout = connectTimeout;
  }

  async connect(req, options) {
    const hostname = options.host.replace(/^\[|\]$/g, '');
    if (Number(options.port) !== 443) throw new ApiError(502, 'UNSAFE_UPSTREAM', 'Only HTTPS upstream connections are allowed.');
    const address = await new Promise((resolve, reject) => this.lookupTarget(hostname, { family: 4 }, (error, address) => error ? reject(error) : resolve(address)));
    if (!ipaddr.isValid(address) || ipaddr.process(address).range() !== 'unicast') throw new ApiError(502, 'UNSAFE_UPSTREAM', 'Upstream resolved to a non-public address.');
    if (req.destroyed) throw new ApiError(502, 'REQUEST_CANCELLED', 'Playback request was cancelled.');
    const controller = new AbortController();
    let timedOut = false, proxyStatus;
    const abort = () => controller.abort();
    const timer = setTimeout(() => { timedOut = true; abort(); }, this.connectTimeout);
    req.once('close', abort);
    // Each pending tunnel gets its own cancellation signal and deadline.
    const connector = new HttpsProxyAgent(this.proxy, { signal: controller.signal, rejectUnauthorized: true });
    connector.on('proxyConnect', response => { proxyStatus = response.statusCode; });
    try {
      const socket = await connector.connect(req, { ...options, host: address,
        servername: isIP(hostname) ? '' : hostname, rejectUnauthorized: true,
        checkServerIdentity: (_, certificate) => checkServerIdentity(hostname, certificate) });
      if (proxyStatus !== 200) {
        socket.destroy();
        throw new ApiError(502, proxyStatus === 407 ? 'PROXY_AUTH_REQUIRED' : 'PROXY_UNAVAILABLE',
          proxyStatus === 407 ? 'The playback proxy credentials were rejected.' : 'The playback proxy could not connect to the video service.');
      }
      return socket;
    } catch (error) {
      abort();
      if (error instanceof ApiError) throw error;
      throw new ApiError(timedOut ? 504 : 502, timedOut ? 'PROXY_TIMEOUT' : 'PROXY_UNAVAILABLE',
        timedOut ? 'The playback proxy timed out.' : 'The playback proxy could not connect to the video service.');
    } finally {
      clearTimeout(timer);
      req.removeListener('close', abort);
    }
  }
}
