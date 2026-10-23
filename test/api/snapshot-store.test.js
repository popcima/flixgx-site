import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SnapshotSessionStore, storedAPIKey } from '../../server/cloudflare/snapshot-store.js';
import { SQLiteSessionStore } from '../../server/cloudflare/store.js';
const origin = 'https://api.example.test';
const source = () => ({ expiresAt: Date.now() + 3600000, headers: { Referer: 'https://provider.example/' } });
const idOf = url => new URL(url).pathname.split('/').at(-1).replace(/\.m3u8$/, '');
function database() {
  const db = new DatabaseSync(':memory:');
  let writes = 0, blocked = false;
  return { db, get writes() { return writes; }, set blocked(value) { blocked = value; }, sql: { exec(query, ...bindings) {
    if (!/^SELECT/i.test(query)) {
      if (blocked) throw new Error('Exceeded allowed rows written in Durable Objects free tier.');
      writes++;
    }
    const statement = db.prepare(query);
    const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => rows };
  } } };
}
test('a thousand playlist resources persist with one snapshot, retain identity after restart, and preserve subtitle host references', () => {
  const fixture = database();
  try {
    let store = new SnapshotSessionStore(['provider.example'], { sql: fixture.sql });
    let session, media, subtitle;
    store.transaction(() => {
      session = store.create(source());
      for (let i = 0; i < 1000; i++) media = store.register(session, `https://cdn.example/${i}.ts`, false, origin, { fromManifest: true });
      subtitle = store.register(session, 'https://cdn.example/subs.m3u8', true, origin, { subtitle: true });
    });
    assert.ok(fixture.writes <= 3, `Expected schema + snapshot + cleanup, got ${fixture.writes}`);
    store = new SnapshotSessionStore(['provider.example'], { sql: fixture.sql });
    const restored = store.get(session.id), hosts = restored.hosts;
    assert.equal(restored.resources.size, 1001);
    assert.equal(restored.resources.get(idOf(media)).url, 'https://cdn.example/999.ts');
    assert.equal(restored.resources.get(idOf(subtitle)).subtitle, true);
    store.transaction(() => store.trustManifestURL(restored, 'https://subs.example/en.vtt'));
    assert.equal(restored.hosts, hosts); assert.ok(hosts.includes('subs.example'));
    assert.equal(store.register(restored, 'https://cdn.example/999.ts', false, origin), media);
  } finally { fixture.db.close(); }
});
test('exhausted free writes preserve the backend key and allow bounded memory playback without repeated write attempts', () => {
  const fixture = database();
  try {
    const key = storedAPIKey(fixture.sql), writes = fixture.writes;
    fixture.blocked = true;
    assert.equal(storedAPIKey(fixture.sql), key); assert.equal(fixture.writes, writes);
    const store = new SnapshotSessionStore(['provider.example'], { sql: fixture.sql, maxSessions: 2 });
    let first;
    for (let i = 0; i < 3; i++) store.transaction(() => {
      const session = store.create(source()); first ||= session;
      const url = store.register(session, 'https://provider.example/master.m3u8', true, origin);
      assert.equal(store.get(session.id).resources.get(idOf(url)).manifest, true);
    });
    assert.equal(store.sessions.size, 2); assert.ok(store.disabledUntil > Date.now());
    assert.throws(() => store.get(first.id), { code: 'SESSION_EXPIRED' });
    assert.doesNotThrow(() => store.cleanup());
    assert.equal(store.nextExpiry(), null);
  } finally { fixture.db.close(); }
});
test('old URLs remain readable after switching to snapshots, including while storage writes are blocked', () => {
  const fixture = database();
  try {
    const old = new SQLiteSessionStore(['provider.example'], { sql: fixture.sql });
    const session = old.create(source());
    const media = old.register(session, 'https://provider.example/1.ts', false, origin);
    fixture.blocked = true;
    const store = new SnapshotSessionStore(['provider.example'], { sql: fixture.sql });
    assert.equal(store.get(session.id).resources.get(idOf(media)).url, 'https://provider.example/1.ts');
    store.transaction(() => store.register(store.get(session.id), 'https://provider.example/2.ts', false, origin));
    assert.equal(store.get(session.id).resources.size, 2);
    fixture.db.prepare('UPDATE playback_sessions SET expires_at = 1 WHERE id = ?').run(session.id);
    const restart = new SnapshotSessionStore(['provider.example'], { sql: fixture.sql });
    assert.throws(() => restart.get(session.id), { code: 'SESSION_EXPIRED' });
  } finally { fixture.db.close(); }
});
test('failed rewrites roll back; unsafe hosts, metadata size and expiry remain enforced', () => {
  const fixture = database();
  try {
    const store = new SnapshotSessionStore(['provider.example'], { sql: fixture.sql, maxSnapshotBytes: 600 });
    const session = store.transaction(() => store.create(source()));
    assert.throws(() => store.transaction(() => {
      store.register(session, 'https://provider.example/1.ts', false, origin);
      store.register(session, 'https://127.0.0.1/2.ts', false, origin, { fromManifest: true });
    }), { code: 'UNSAFE_UPSTREAM' });
    assert.equal(store.get(session.id).resources.size, 0);
    assert.throws(() => store.transaction(() => {
      for (let i=0; i<10; i++) store.register(store.get(session.id), `https://provider.example/${i}.ts`, false, origin);
    }), { code: 'RESOURCE_LIMIT' });
    assert.equal(store.get(session.id).resources.size, 0);
    store.get(session.id).expiresAt = 1;
    assert.throws(() => store.get(session.id), { code: 'SESSION_EXPIRED' });
  } finally { fixture.db.close(); }
});
