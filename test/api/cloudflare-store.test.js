import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteSessionStore } from '../../server/cloudflare/store.js';
import { allowedURL } from '../../server/api/network.js';

const baseURL = 'https://api.example.test';
const source = () => ({ expiresAt: Date.now() + 3600000, headers: { Referer: 'https://provider.example/player' } });
function adapter(db) {
  return { exec(query, ...bindings) {
    const statement = db.prepare(query);
    const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => rows };
  } };
}
function resourceId(url) { return new URL(url).pathname.split('/').at(-1).replace(/\.m3u8$/, ''); }

test('SQLite playback sessions, resources, subtitles, and host additions survive a real database reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flixgx-do-store-'));
  let db;
  try {
    const file = join(directory, 'sessions.sqlite');
    db = new DatabaseSync(file);
    let alarm;
    let store = new SQLiteSessionStore(['provider.example'], { sql: adapter(db), onExpiry: expiry => { alarm = expiry; } });
    const session = store.create(source());
    assert.match(session.id, /^[a-f0-9]{48}$/);
    assert.equal(alarm, session.expiresAt);
    const master = store.register(session, 'https://provider.example/master.m3u8', true, baseURL);
    assert.match(resourceId(master), /^[a-f0-9]{24}$/);
    const subtitle = store.register(session, 'https://cdn.example/subtitle.m3u8', true, baseURL, { fromManifest: true });
    assert.equal(store.register(session, 'https://cdn.example/subtitle.m3u8', true, baseURL, { subtitle: true }), subtitle);
    const media = store.register(session, 'https://cdn.example/segment.ts', false, baseURL);
    db.close();
    db = new DatabaseSync(file);
    store = new SQLiteSessionStore(['provider.example'], { sql: adapter(db) });
    const restored = store.get(session.id);
    assert.deepEqual(restored.headers, source().headers);
    assert.ok(restored.hosts.includes('cdn.example'));
    assert.equal(restored.resources.size, 3);
    assert.deepEqual(restored.resources.get(resourceId(subtitle)), { url: 'https://cdn.example/subtitle.m3u8', manifest: true, subtitle: true });
    assert.deepEqual(restored.resources.get(resourceId(media)), { url: 'https://cdn.example/segment.ts', manifest: false });
    assert.equal(store.register(restored, 'https://provider.example/master.m3u8', true, baseURL), master);
    assert.equal(restored.resources.size, 3);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SQLite store rejects unknown/expired sessions and prunes their metadata and resources', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new SQLiteSessionStore(['provider.example'], { sql: adapter(db) });
    assert.throws(() => store.get('0'.repeat(48)), { code: 'SESSION_EXPIRED', status: 410 });
    assert.throws(() => store.create({ ...source(), expiresAt: Date.now() + 1000 }), { code: 'EXPIRED_SOURCE' });
    const expired = store.create(source());
    const pruned = store.create(source());
    const live = store.create(source());
    for (const session of [expired, pruned, live]) store.register(session, 'https://provider.example/master.m3u8', true, baseURL);
    db.prepare('UPDATE playback_sessions SET expires_at = 1 WHERE id IN (?, ?)').run(expired.id, pruned.id);
    assert.throws(() => store.get(expired.id), { code: 'SESSION_EXPIRED' });
    store.prune();
    assert.equal(store.first('SELECT COUNT(*) AS count FROM playback_sessions').count, 1);
    assert.equal(store.first('SELECT COUNT(*) AS count FROM playback_resources').count, 1);
    assert.equal(store.get(live.id).resources.size, 1);
    assert.equal(store.nextExpiry(), live.expiresAt);
  } finally { db.close(); }
});

test('SQLite store retains host and resource bounds across separate store instances', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const options = { sql: adapter(db), maxSessions: 1, maxResources: 2 };
    let store = new SQLiteSessionStore(['provider.example'], options);
    const session = store.create(source());
    assert.throws(() => store.create(source()), { code: 'SESSION_LIMIT' });
    for (const url of ['https://localhost/a', 'https://127.0.0.1/a', 'https://10.0.0.1/a', 'https://[::1]/a', 'http://cdn.example/a', 'https://cdn.example:8443/a', 'https://user:pass@cdn.example/a']) {
      assert.throws(() => store.register(session, url, false, baseURL, { fromManifest: true }), { code: 'UNSAFE_UPSTREAM' });
    }
    assert.throws(() => store.register(session, 'https://untrusted.example/a', false, baseURL), { code: 'UNSAFE_UPSTREAM' });
    assert.equal(session.resources.size, 0);
    assert.equal(session.resources.get('0'.repeat(24)), undefined);
    store.register(session, 'https://provider.example/1.ts', false, baseURL);
    store.register(session, 'https://provider.example/2.ts', false, baseURL);
    store = new SQLiteSessionStore(['provider.example'], options);
    assert.throws(() => store.register(store.get(session.id), 'https://provider.example/3.ts', false, baseURL), { code: 'RESOURCE_LIMIT' });
    assert.equal(store.get(session.id).resources.size, 2);
  } finally { db.close(); }
});

test('SQLite manifest registration can roll back atomically and merge hosts from concurrent handles', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new SQLiteSessionStore(['provider.example'], { sql: adapter(db), maxResources: 1 });
    const session = store.create(source());
    const concurrent = store.get(session.id);
    const subtitleHosts = session.hosts;
    store.trustManifestURL(session, 'https://cdn-one.example/1.ts');
    assert.equal(session.hosts, subtitleHosts);
    assert.doesNotThrow(() => allowedURL('https://cdn-one.example/subtitles.vtt', subtitleHosts));
    store.trustManifestURL(concurrent, 'https://cdn-two.example/2.ts');
    assert.deepEqual(store.get(session.id).hosts, ['provider.example', 'cdn-one.example', 'cdn-two.example']);
    store.trustManifestURL(session, 'https://cdn-one.example/another.ts');
    assert.doesNotThrow(() => allowedURL('https://cdn-two.example/subtitles.vtt', subtitleHosts));
    db.exec('BEGIN');
    store.register(session, 'https://provider.example/1.ts', false, baseURL);
    assert.throws(() => store.register(session, 'https://provider.example/2.ts', false, baseURL), { code: 'RESOURCE_LIMIT' });
    db.exec('ROLLBACK');
    assert.equal(session.resources.size, 0);
    assert.doesNotThrow(() => store.register(session, 'https://provider.example/2.ts', false, baseURL));
    assert.equal(session.resources.size, 1);
  } finally { db.close(); }
});
