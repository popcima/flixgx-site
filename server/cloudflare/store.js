import { randomBytes } from 'node:crypto';
import { SessionStore } from '../api/sessions.js';
import { ApiError } from '../api/errors.js';
import { allowedURL } from '../api/network.js';

// Pass a Durable Object's ctx.storage.sql. SQL is the authoritative store;
// cached facades are only used within the current request. Wrap a whole
// manifest rewrite in ctx.storage.transactionSync() to batch registrations.
export class SQLiteSessionStore extends SessionStore {
  constructor(hosts, { sql, maxSessions = 128, ttl = 6 * 3600000, maxResources = 20000, onExpiry } = {}) {
    super(hosts, { maxSessions, ttl });
    if (!sql?.exec) throw new TypeError('SQLiteSessionStore requires a SQL storage object.');
    this.sql = sql;
    this.maxResources = maxResources;
    this.onExpiry = onExpiry;
    sql.exec(`CREATE TABLE IF NOT EXISTS playback_sessions (
      id TEXT PRIMARY KEY, headers TEXT NOT NULL, hosts TEXT NOT NULL, expires_at INTEGER NOT NULL,
      resource_count INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS playback_sessions_expiry ON playback_sessions(expires_at)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS playback_resources (
      session_id TEXT NOT NULL, id TEXT NOT NULL, url TEXT NOT NULL,
      manifest INTEGER NOT NULL, subtitle INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, id), UNIQUE (session_id, manifest, url)
    )`);
    // A persisted counter keeps the cap correct after restarts and transaction
    // rollbacks without scanning all preceding resources for every segment.
    sql.exec(`CREATE TRIGGER IF NOT EXISTS playback_resource_insert AFTER INSERT ON playback_resources
      BEGIN UPDATE playback_sessions SET resource_count = resource_count + 1 WHERE id = NEW.session_id; END`);
  }

  first(query, ...bindings) { return this.sql.exec(query, ...bindings).toArray()[0]; }

  nextExpiry() {
    return this.first('SELECT MIN(expires_at) AS expiry FROM playback_sessions')?.expiry ?? null;
  }

  prune() {
    const now = Date.now();
    // Resources go first, so an interruption cannot leave unbounded orphan rows.
    this.sql.exec('DELETE FROM playback_resources WHERE session_id IN (SELECT id FROM playback_sessions WHERE expires_at <= ?)', now);
    this.sql.exec('DELETE FROM playback_sessions WHERE expires_at <= ?', now);
  }

  create(source) {
    this.prune();
    if (this.first('SELECT COUNT(*) AS count FROM playback_sessions').count >= this.maxSessions) {
      throw new ApiError(503, 'SESSION_LIMIT', 'Playback session capacity reached. Try later.');
    }
    const expiresAt = Math.min(Date.now() + this.ttl, source.expiresAt - 60000);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new ApiError(502, 'EXPIRED_SOURCE', 'Stream already expired.');
    const id = randomBytes(24).toString('hex');
    this.sql.exec('INSERT INTO playback_sessions (id, headers, hosts, expires_at) VALUES (?, ?, ?, ?)',
      id, JSON.stringify(source.headers || {}), JSON.stringify(this.hosts), expiresAt);
    // The caller owns any asynchronous setAlarm promise, e.g. via ctx.waitUntil.
    this.onExpiry?.(this.nextExpiry());
    return this.get(id);
  }

  get(id) {
    const row = this.first('SELECT id, headers, hosts, expires_at FROM playback_sessions WHERE id = ?', id);
    if (!row || row.expires_at <= Date.now()) {
      if (row) {
        this.sql.exec('DELETE FROM playback_resources WHERE session_id = ?', id);
        this.sql.exec('DELETE FROM playback_sessions WHERE id = ?', id);
      }
      throw new ApiError(410, 'SESSION_EXPIRED', 'Resolve the TMDB ID again to get a fresh playback URL.');
    }
    const store = this;
    const resources = {
      get(resourceId) {
        const resource = store.first('SELECT url, manifest, subtitle FROM playback_resources WHERE session_id = ? AND id = ?', id, resourceId);
        return resource ? { url: resource.url, manifest: Boolean(resource.manifest), ...(resource.subtitle ? { subtitle: true } : {}) } : undefined;
      },
      get size() {
        return store.first('SELECT resource_count AS count FROM playback_sessions WHERE id = ?', id)?.count ?? 0;
      },
    };
    const index = {
      get(key) {
        const split = key.indexOf(':');
        return store.first('SELECT id FROM playback_resources WHERE session_id = ? AND manifest = ? AND url = ?',
          id, key.slice(0, split) === 'true' ? 1 : 0, key.slice(split + 1))?.id;
      },
    };
    return { id, headers: JSON.parse(row.headers), expiresAt: row.expires_at,
      hosts: JSON.parse(row.hosts), resources, index };
  }

  trustManifestURL(session, value) {
    // Concurrent manifest requests may have obtained different session objects.
    // Merge against SQL at the point of registration instead of overwriting
    // another request's newly trusted CDN host with a stale array.
    const stored = this.first('SELECT hosts FROM playback_sessions WHERE id = ?', session.id);
    if (!stored) throw new ApiError(410, 'SESSION_EXPIRED', 'Resolve the TMDB ID again to get a fresh playback URL.');
    // Subtitle fetchers retain this array while discovering the VTT URL. Keep
    // its identity so those existing readers see newly trusted hosts as well.
    session.hosts.splice(0, session.hosts.length, ...JSON.parse(stored.hosts));
    const count = session.hosts.length;
    super.trustManifestURL(session, value);
    if (session.hosts.length !== count) {
      this.sql.exec('UPDATE playback_sessions SET hosts = ? WHERE id = ?', JSON.stringify(session.hosts), session.id);
    }
  }

  register(session, url, manifest, baseURL, { subtitle = false, fromManifest = false } = {}) {
    if (session.expiresAt <= Date.now()) throw new ApiError(410, 'SESSION_EXPIRED', 'Resolve the TMDB ID again to get a fresh playback URL.');
    if (fromManifest) this.trustManifestURL(session, url);
    allowedURL(url, session.hosts);
    let id = session.index.get(`${Boolean(manifest)}:${url}`);
    if (!id) {
      if (session.resources.size >= this.maxResources) throw new ApiError(502, 'RESOURCE_LIMIT', 'Manifest has too many resources.');
      id = randomBytes(12).toString('hex');
      this.sql.exec('INSERT INTO playback_resources (session_id, id, url, manifest, subtitle) VALUES (?, ?, ?, ?, ?)',
        session.id, id, url, manifest ? 1 : 0, subtitle ? 1 : 0);
    } else if (subtitle && !session.resources.get(id)?.subtitle) {
      this.sql.exec('UPDATE playback_resources SET subtitle = 1 WHERE session_id = ? AND id = ?', session.id, id);
    }
    return `${baseURL}/v1/media/${session.id}/${id}${manifest ? '.m3u8' : ''}`;
  }
}
