import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { allowedURL, isPublicAddress } from './network.js';
import { ApiError } from './errors.js';

export class SessionStore {
  constructor(hosts, { maxSessions = 128, ttl = 6 * 3600000 } = {}) {
    this.hosts = hosts; this.maxSessions = maxSessions; this.ttl = ttl; this.sessions = new Map();
  }
  prune() {
    for (const [id, value] of this.sessions) if (value.expiresAt <= Date.now()) this.sessions.delete(id);
  }
  create(source) {
    this.prune();
    if (this.sessions.size >= this.maxSessions) throw new ApiError(503, 'SESSION_LIMIT', 'Playback session capacity reached. Try later.');
    const session = { id: randomBytes(24).toString('hex'), headers: source.headers,
      expiresAt: Math.min(Date.now() + this.ttl, source.expiresAt - 60000), hosts: [...this.hosts], resources: new Map(), index: new Map() };
    if (session.expiresAt <= Date.now()) throw new ApiError(502, 'EXPIRED_SOURCE', 'Stream already expired.');
    this.sessions.set(session.id, session);
    return session;
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      throw new ApiError(410, 'SESSION_EXPIRED', 'Resolve the TMDB ID again to get a fresh playback URL.');
    }
    return session;
  }
  trustManifestURL(session, value) {
    // Only call for a URI parsed from an already trusted provider playlist.
    // Visitors cannot submit URLs. Every actual socket still checks DNS for
    // public addresses, including redirects, in network.js.
    let parsed;
    try { parsed = new URL(value); } catch { throw new ApiError(502, 'UNSAFE_UPSTREAM', 'Invalid playlist resource URL.'); }
    const hostname = parsed.hostname, address = hostname.replace(/^\[|\]$/g, '');
    allowedURL(value, [hostname]);
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || (isIP(address) && !isPublicAddress(address))) {
      throw new ApiError(502, 'UNSAFE_UPSTREAM', 'Playlist resources must use public addresses.');
    }
    if (!session.hosts.includes(hostname)) {
      if (session.hosts.length >= 64) throw new ApiError(502, 'HOST_LIMIT', 'Playlist references too many media hosts.');
      session.hosts.push(hostname);
    }
  }
  register(session, url, manifest, baseURL, { subtitle = false, fromManifest = false } = {}) {
    if (fromManifest) this.trustManifestURL(session, url);
    allowedURL(url, session.hosts);
    const key = `${manifest}:${url}`;
    let id = session.index.get(key);
    if (!id) {
      if (session.resources.size >= 20000) throw new ApiError(502, 'RESOURCE_LIMIT', 'Manifest has too many resources.');
      id = randomBytes(12).toString('hex');
      session.resources.set(id, { url, manifest }); session.index.set(key, id);
    }
    if (subtitle) session.resources.get(id).subtitle = true;
    return `${baseURL}/v1/media/${session.id}/${id}${manifest ? '.m3u8' : ''}`;
  }
}

export class Resolver {
  constructor(provider, store, baseURL, { onResolved = () => {}, transaction = operation => operation() } = {}) { this.provider = provider; this.store = store; this.baseURL = baseURL; this.onResolved = onResolved; this.transaction = transaction; this.cache = new Map(); this.pending = new Map(); }
  async resolve(target, { refresh = false } = {}) {
    const key = JSON.stringify(target);
    if (refresh) this.cache.delete(key);
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) {
      try { this.store.get(cached.sessionId); return cached.result; } catch { this.cache.delete(key); }
    }
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= 4) throw new ApiError(429, 'RESOLVER_BUSY', 'Too many simultaneous resolutions. Retry shortly.');
    const job = this.perform(target).then(result => {
      for (const [k, v] of this.cache) if (v.until <= Date.now()) this.cache.delete(k);
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value);
      const sessionId = new URL(result.sources[0].playbackUrl).pathname.split('/')[3];
      this.cache.set(key, { result, sessionId, until: Math.min(Date.now() + 120000, Date.parse(result.expiresAt)) });
      return result;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, job); return job;
  }
  async perform(target) {
    const source = await this.provider(target);
    return this.transaction(() => this.registerSource(target, source));
  }
  registerSource(target, source) {
    const session = this.store.create(source);
    const playbackUrl = this.store.register(session, source.url, true, this.baseURL);
    const subtitles = (source.subtitles || []).map(track => {
      if (!track.url) return track;
      const playlistUrl = this.store.register(session, track.url, true, this.baseURL, { subtitle: true, fromManifest: true });
      return { ...track, format: 'hls', playlistUrl,
        vttUrl: playlistUrl.replace('/v1/media/', '/v1/subtitles/').replace(/\.m3u8$/, '.vtt') };
    });
    this.onResolved(session, source, playbackUrl);
    return { ...target, provider: 'vidpro', providerPage: source.pageURL, resolvedAt: new Date().toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      sources: [{ type: 'hls', mimeType: 'application/vnd.apple.mpegurl', url: source.url, playbackUrl,
        upstreamExpiresAt: new Date(source.expiresAt).toISOString(), requestHeaders: source.headers,
        qualities: source.qualities, audioTracks: source.audioTracks, subtitles }] };
  }
}
