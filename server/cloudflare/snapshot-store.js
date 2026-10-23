import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { SessionStore } from '../api/sessions.js';
import { ApiError } from '../api/errors.js';

const quotaExceeded = error => /Exceeded allowed rows (?:written|read).*free tier/i.test(error?.message || '');
const missingTable = error => /no such table/i.test(error?.message || '');
const nextDay = () => (Math.floor(Date.now() / 86400000) + 1) * 86400000;
const encode = session => JSON.stringify({ id: session.id, headers: session.headers, hosts: session.hosts,
  expiresAt: session.expiresAt, resources: [...session.resources] });
function decode(body) {
  const value = JSON.parse(typeof body === 'string' ? body : gunzipSync(body, { maxOutputLength: 4 * 1024 * 1024 }).toString()), resources = new Map(value.resources);
  return { ...value, resources, index: new Map([...resources].map(([id, r]) => [`${Boolean(r.manifest)}:${r.url}`, id])) };
}

// Preserve the generated backend credential without issuing DDL on every restart.
export function storedAPIKey(sql) {
  try {
    const saved = sql.exec('SELECT value FROM api_settings WHERE name = ?', 'api_key').toArray()[0];
    if (saved) return saved.value;
  } catch (error) { if (!missingTable(error) && !quotaExceeded(error)) throw error; }
  const value = randomBytes(32).toString('hex');
  try {
    sql.exec('CREATE TABLE IF NOT EXISTS api_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec('INSERT INTO api_settings (name, value) VALUES (?, ?)', 'api_key', value);
  } catch (error) { if (!quotaExceeded(error)) throw error; }
  return value;
}

// One snapshot per changed playlist, instead of several SQL writes per segment.
// A storage quota failure degrades to bounded memory until the daily quota resets.
export class SnapshotSessionStore extends SessionStore {
  constructor(hosts, { sql, maxSessions = 128, maxBytes = 8 * 1024 * 1024, maxSnapshotBytes = 4 * 1024 * 1024, onExpiry } = {}) {
    super(hosts, { maxSessions });
    Object.assign(this, { sql, maxBytes, maxSnapshotBytes, onExpiry });
    this.dirty = new Set(); this.sizes = new Map(); this.bytes = 0;
    this.depth = 0; this.backups = null; this.disabledUntil = 0; this.tableReady = false;
  }
  first(query, ...bindings) { return this.sql.exec(query, ...bindings).toArray()[0]; }
  forget(id) {
    this.bytes -= this.sizes.get(id) || 0; this.sizes.delete(id); this.sessions.delete(id); this.dirty.delete(id);
  }
  prune() {
    for (const [id, session] of this.sessions) if (session.expiresAt <= Date.now()) this.forget(id);
  }
  remember(session, bytes = Buffer.byteLength(encode(session))) {
    if (bytes > this.maxSnapshotBytes) throw new ApiError(502, 'RESOURCE_LIMIT', 'Playback metadata is too large.');
    this.bytes += bytes - (this.sizes.get(session.id) || 0); this.sizes.set(session.id, bytes);
    this.sessions.delete(session.id); this.sessions.set(session.id, session);
    while (this.sessions.size > this.maxSessions || this.bytes > this.maxBytes) this.forget(this.sessions.keys().next().value);
    return session;
  }
  touch(session) {
    if (this.backups && !this.backups.has(session.id)) this.backups.set(session.id, encode(session));
    this.dirty.add(session.id);
  }
  create(source) {
    this.prune();
    if (this.sessions.size >= this.maxSessions) this.forget(this.sessions.keys().next().value);
    const session = super.create(source);
    this.backups?.set(session.id, null); this.dirty.add(session.id);
    return this.remember(session);
  }
  get(id) {
    let session = this.sessions.get(id);
    if (!session) {
      try {
        let row;
        try { row = this.first('SELECT body FROM playback_snapshots WHERE id = ? AND expires_at > ?', id, Date.now()); }
        catch (error) { if (!missingTable(error)) throw error; }
        if (row) session = decode(row.body);
        else {
          // Read old URLs without writing more rows into the legacy schema.
          try { row = this.first('SELECT headers, hosts, expires_at FROM playback_sessions WHERE id = ? AND expires_at > ?', id, Date.now()); }
          catch (error) { if (!missingTable(error)) throw error; }
          if (row) {
            const resources = this.sql.exec('SELECT id, url, manifest, subtitle FROM playback_resources WHERE session_id = ?', id).toArray();
            session = decode(JSON.stringify({ id, headers: JSON.parse(row.headers), hosts: JSON.parse(row.hosts), expiresAt: row.expires_at,
              resources: resources.map(r => [r.id, { url: r.url, manifest: Boolean(r.manifest), ...(r.subtitle ? { subtitle: true } : {}) }]) }));
          }
        }
      } catch (error) { if (!quotaExceeded(error)) throw error; }
      if (session) this.remember(session);
    }
    if (!session || session.expiresAt <= Date.now()) {
      this.forget(id); throw new ApiError(410, 'SESSION_EXPIRED', 'Resolve the TMDB ID again to get a fresh playback URL.');
    }
    this.sessions.delete(id); this.sessions.set(id, session);
    return session;
  }
  trustManifestURL(session, value) {
    const canonical = this.get(session.id); this.touch(canonical);
    super.trustManifestURL(canonical, value);
    if (session !== canonical) session.hosts.splice(0, session.hosts.length, ...canonical.hosts);
  }
  register(session, ...args) {
    session = this.get(session.id); this.touch(session);
    return super.register(session, ...args);
  }
  transaction(operation) {
    if (this.depth) return operation();
    this.depth++; this.backups = new Map(); const oldDirty = new Set(this.dirty);
    try {
      const result = operation();
      this.flush();
      return result;
    } catch (error) {
      for (const [id, body] of this.backups) {
        this.forget(id);
        if (body !== null) this.remember(decode(body));
      }
      this.dirty = oldDirty;
      throw error;
    } finally { this.depth--; this.backups = null; }
  }
  ensureTable() {
    if (this.tableReady) return;
    this.sql.exec('CREATE TABLE IF NOT EXISTS playback_snapshots (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, body TEXT NOT NULL)');
    this.tableReady = true;
  }
  flush() {
    const pending = [];
    for (const id of this.dirty) {
      const session = this.sessions.get(id);
      if (!session) continue;
      const body = encode(session); this.remember(session, Buffer.byteLength(body));
      pending.push([id, session.expiresAt, body]);
    }
    if (Date.now() < this.disabledUntil) return;
    try {
      this.ensureTable();
      for (const [id, expiresAt, body] of pending) {
        if (!this.sessions.has(id)) continue;
        // Repeated signed CDN prefixes compress well. Keep each SQL row below
        // Cloudflare's 2 MB limit; unusually large snapshots remain memory-only.
        const compressed = gzipSync(body);
        if (compressed.byteLength > 1900000) continue;
        this.sql.exec('INSERT INTO playback_snapshots (id, expires_at, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at, body = excluded.body', id, expiresAt, compressed);
        this.dirty.delete(id);
      }
      // Bound persistent snapshots too. Legacy rows remain readable until cleanup.
      this.sql.exec('DELETE FROM playback_snapshots WHERE expires_at <= ? OR id IN (SELECT id FROM playback_snapshots ORDER BY expires_at DESC LIMIT -1 OFFSET ?)', Date.now(), this.maxSessions);
      if (pending.length) this.onExpiry?.(Math.min(...pending.map(([, expiresAt]) => expiresAt)));
    } catch (error) {
      if (!quotaExceeded(error)) throw error;
      this.disabledUntil = nextDay();
    }
  }
  cleanup() {
    this.prune();
    if (Date.now() < this.disabledUntil) return;
    try {
      this.ensureTable();
      this.sql.exec('DELETE FROM playback_snapshots WHERE expires_at <= ?', Date.now());
      // Retire old segment rows in small batches, rather than another write burst.
      try {
        this.sql.exec('DELETE FROM playback_resources WHERE rowid IN (SELECT r.rowid FROM playback_resources r JOIN playback_sessions s ON s.id = r.session_id WHERE s.expires_at <= ? LIMIT 100)', Date.now());
        this.sql.exec('DELETE FROM playback_sessions WHERE expires_at <= ? AND id NOT IN (SELECT session_id FROM playback_resources)', Date.now());
      } catch (error) { if (!missingTable(error)) throw error; }
    } catch (error) { if (!quotaExceeded(error)) throw error; this.disabledUntil = nextDay(); }
  }
  nextExpiry() {
    if (Date.now() < this.disabledUntil) return null;
    try { return this.first('SELECT MIN(expires_at) AS expiry FROM playback_snapshots')?.expiry ?? null; }
    catch (error) { if (!missingTable(error) && !quotaExceeded(error)) throw error; return null; }
  }
}
