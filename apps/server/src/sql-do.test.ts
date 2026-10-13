// The Worker keeps every database in one Durable Object. These tests pin the
// two things that has to be true: no table is defined twice across the old
// files, and the SQL adapter gives the stores what node:sqlite did.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AlbumGroupStore } from './album-groups.ts';
import { TasteDb } from './db.ts';
import { ShelfStore } from './discogs.ts';
import { fakeDurableObjectStorage } from './fake-do.ts';
import { FileIdentityStore } from './file-identity.ts';
import { LikesStore } from './likes.ts';
import { ListenBrainz } from './listenbrainz.ts';
import { LyricsService } from './lyrics.ts';
import { PlaylistStore } from './playlists.ts';
import { PlaysStore } from './plays.ts';
import { ProvenanceStore } from './provenance.ts';
import { durableObjectSql } from './sql-do.ts';
import { nodeSql } from './sql-node.ts';
import { fitLike, provideSql, type SqlHost } from './sql.ts';
import { UpgradeStore } from './upgrades.ts';

// Every store the app opens, each on the file it uses in production.
const FILES = {
  spotify: ['spotify.db', (f: string) => { new TasteDb(f); new AlbumGroupStore(f); }],
  provenance: ['provenance.db', (f: string) => { new FileIdentityStore(f); new ProvenanceStore(f).ready(); }],
  upgrades: ['upgrades.db', (f: string) => { new UpgradeStore(f); }],
  likes: ['likes.db', (f: string) => { new LikesStore(f); }],
  playlists: ['playlists.db', (f: string) => { new PlaylistStore(f); }],
  plays: ['app-plays.db', (f: string) => { new PlaysStore(f).ready(); }],
  lyrics: ['lyrics.db', (f: string) => { new LyricsService(f).ready(); }],
  listenbrainz: ['listenbrainz.db', (f: string) => { new ListenBrainz({ dbFile: f }).ready(); }],
  discogs: ['discogs.db', (f: string) => { new ShelfStore(f).ready(); }],
} as const;

function open(host: SqlHost, file: string) {
  provideSql(host);
  return host.open(file);
}

function schemaNames(db: ReturnType<typeof open>): string[] {
  return db.prepare("SELECT type || ' ' || name AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().map((r) => String(r.n));
}

test('no table or index name is used by two of the database files', () => {
  provideSql(nodeSql);
  const seen = new Map<string, string>();
  for (const [label, [file, build]] of Object.entries(FILES)) {
    // Each file on its own in-memory database, so the names it defines are its own.
    const memory = `:memory:`;
    const probe = nodeSql.open(memory);
    // The store opens its own connection; ask it for the schema through a host that hands back this one.
    provideSql({ open: () => probe });
    build(memory);
    for (const name of schemaNames(probe)) {
      assert.equal(seen.get(name), undefined, `${name} is defined by both ${seen.get(name)} and ${label}`);
      seen.set(name, label);
    }
  }
  assert.ok(seen.size > 40, `expected the full schema, found ${seen.size} names`);
});

test('every store builds on one Durable Object database, with the same tables as the separate files', () => {
  const separate = new Set<string>();
  for (const [file, build] of Object.values(FILES)) {
    const probe = nodeSql.open(':memory:');
    provideSql({ open: () => probe });
    build(file);
    for (const name of schemaNames(probe)) separate.add(name);
  }

  const host = durableObjectSql(fakeDurableObjectStorage());
  provideSql(host);
  for (const [file, build] of Object.values(FILES)) build(file);
  assert.deepEqual(new Set(schemaNames(host.open('anything'))), separate);
});

test('the adapter reports changes and the new row id, and drops the tuning pragmas', () => {
  const db = durableObjectSql(fakeDurableObjectStorage()).open('x');
  db.exec('PRAGMA journal_mode = WAL;\nPRAGMA busy_timeout = 5000;\nCREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
  const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
  assert.deepEqual(insert.run('a'), { changes: 1, lastInsertRowid: 1 });
  assert.deepEqual(insert.run('b'), { changes: 1, lastInsertRowid: 2 });
  assert.deepEqual(db.prepare('UPDATE t SET v = ?').run('z'), { changes: 2, lastInsertRowid: 2 });
  assert.deepEqual(db.prepare('SELECT v FROM t ORDER BY id').all(), [{ v: 'z' }, { v: 'z' }]);
  assert.equal(db.prepare('SELECT v FROM t WHERE id = ?').get(99), undefined);
});

test('booleans, undefined and bigints bind as SQLite values', () => {
  const db = durableObjectSql(fakeDurableObjectStorage()).open('x');
  assert.deepEqual(db.prepare('SELECT ? AS a, ? AS b, ? AS c').get(true, undefined, 7n), { a: 1, b: null, c: 7 });
});

test('a transaction commits together and rolls back on a throw, and says when it is open', () => {
  const db = durableObjectSql(fakeDurableObjectStorage()).open('x');
  db.exec('CREATE TABLE t (v TEXT)');
  assert.equal(db.inTransaction, false);
  db.transaction(() => {
    assert.equal(db.inTransaction, true);
    db.prepare('INSERT INTO t VALUES (?)').run('kept');
  });
  assert.throws(() => db.transaction(() => {
    db.prepare('INSERT INTO t VALUES (?)').run('lost');
    throw new Error('boom');
  }), /boom/);
  assert.equal(db.inTransaction, false);
  assert.deepEqual(db.prepare('SELECT v FROM t').all(), [{ v: 'kept' }]);
});

test('the real stores work on it: a queue claim, a like and a playlist', () => {
  provideSql(durableObjectSql(fakeDurableObjectStorage()));
  const upgrades = new UpgradeStore('upgrades');
  const job = upgrades.create({ sourceUrl: 'https://youtu.be/abc', artist: 'Igorrr', title: 'Cuisse', album: 'Maigre' });
  const claimed = upgrades.claim('worker-1');
  assert.equal(claimed?.id, job.id);
  assert.equal(upgrades.claim('worker-2'), null);

  const likes = new LikesStore('likes');
  likes.set('t1', true);
  assert.deepEqual(likes.liked('track').map((c) => c.id), ['t1']);

  const playlists = new PlaylistStore('playlists');
  assert.deepEqual(playlists.list().map((p) => p.name), ['Voyage 35']);
});

test('fitLike leaves a short pattern alone and cuts a long one to 50 bytes without breaking an escape or a character', () => {
  assert.equal(fitLike('%night%'), '%night%');
  const long = fitLike(`%${'a'.repeat(80)}%`);
  assert.equal(long, `%${'a'.repeat(48)}%`);
  assert.equal(new TextEncoder().encode(long).length, 50);
  // Cut right after an escaping backslash: the backslash goes too, not the character it protects.
  const escaped = fitLike(`%${'b'.repeat(47)}\\_${'c'.repeat(20)}%`);
  assert.ok(!/(^|[^\\])\\%$/.test(escaped) && escaped.endsWith('%'), escaped);
  assert.ok(new TextEncoder().encode(escaped).length <= 50);
  const accented = fitLike(`%${'é'.repeat(40)}%`);
  assert.ok(new TextEncoder().encode(accented).length <= 50 && !accented.includes('�'));
});
