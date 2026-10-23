// Keep only small, short-lived playlists. Video bytes never accumulate here.
export class ManifestCache {
  constructor({ maxBytes = 8 * 1024 * 1024, maxEntries = 64, ttl = 120000, now = Date.now } = {}) {
    Object.assign(this, { maxBytes, maxEntries, ttl, now });
    this.entries = new Map(); this.bytes = 0;
  }
  remove(key) {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); }
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.until <= this.now()) { this.remove(key); return; }
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.body;
  }
  put(key, body, expiresAt) {
    // Growing/live media playlists must always be refreshed upstream.
    if (!/^#EXT-X-STREAM-INF:/m.test(body) && !/^#EXT-X-ENDLIST\s*$/m.test(body)) return;
    const bytes = Buffer.byteLength(body), until = Math.min(this.now() + this.ttl, expiresAt);
    if (bytes > this.maxBytes || !Number.isFinite(until) || until <= this.now()) return;
    for (const [id, entry] of this.entries) if (entry.until <= this.now()) this.remove(id);
    this.remove(key);
    while (this.entries.size && (this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries)) this.remove(this.entries.keys().next().value);
    this.entries.set(key, { body, bytes, until }); this.bytes += bytes;
  }
}
