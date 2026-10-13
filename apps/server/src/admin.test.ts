// The routes that move the data into and out of the Durable Object, run on the
// same SQL adapter the Worker uses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAdmin, type AdminHost } from './admin.ts';
import { TasteDb } from './db.ts';
import { fakeDurableObjectStorage } from './fake-do.ts';
import { LikesStore } from './likes.ts';
import { provideSql } from './sql.ts';
import { durableObjectSql } from './sql-do.ts';

function setup() {
  const sql = durableObjectSql(fakeDurableObjectStorage());
  provideSql(sql);
  const taste = new TasteDb('spotify');
  new LikesStore('likes');
  const kept = new Map<string, string>();
  const host: AdminHost = {
    sql: sql.open('admin'),
    token: 'secret-token',
    state: { async fetch(url, init) {
      if (init?.method === 'PUT') { kept.set(url, String(init.body)); return new Response(null, { status: 204 }); }
      return kept.has(url) ? new Response(kept.get(url)) : new Response('no', { status: 404 });
    } },
    nightly: { start: () => true, status: () => ({ running: false, startedAt: null, finishedAt: null, errors: [] }) },
  };
  const call = (path: string, init: RequestInit & { token?: string | null } = {}) => handleAdmin(
    new Request(`http://worker${path}`, { ...init, headers: { ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? 'secret-token'}` }), ...init.headers } }), host,
  );
  return { taste, host, call, kept };
}
const batch = (columns: string[], rows: unknown[][]) => JSON.stringify({ columns, rows });

test('without the token every admin route is a 404, and other paths are not its business', async () => {
  const { call } = setup();
  assert.equal((await call('/_workers/status', { token: null }))!.status, 404);
  assert.equal((await call('/_workers/status', { token: 'wrong' }))!.status, 404);
  assert.equal(await call('/api/stats'), null);
});

test('rows imported into a table come back out of it, in rowid order, in pages', async () => {
  const { call } = setup();
  const columns = ['id', 'name', 'popularity'];
  const rows = Array.from({ length: 7 }, (_, i) => [`a${i}`, `Artist ${i}`, i === 3 ? null : i * 10]);
  const imported = await call('/_workers/import/artists', { method: 'POST', body: batch(columns, rows) });
  assert.equal(imported!.status, 200);
  assert.deepEqual(await imported!.json(), { table: 'artists', inserted: 7 });

  const first = await (await call('/_workers/export/artists?limit=3'))!.json() as { columns: string[]; rows: unknown[][]; next: number | null };
  assert.equal(first.rows.length, 3);
  assert.notEqual(first.next, null);
  const second = await (await call(`/_workers/export/artists?limit=10&after=${first.next}`))!.json() as { rows: unknown[][]; next: number | null };
  assert.equal(second.rows.length, 4);
  assert.equal(second.next, null);
  const back = [...first.rows, ...second.rows].map((r) => Object.fromEntries(first.columns.map((c, i) => [c, r[i]])));
  assert.deepEqual(back.map((r) => [r.id, r.name, r.popularity]), rows);
});

test('replace=1 clears the table first, so an import can be run again', async () => {
  const { call, taste } = setup();
  await call('/_workers/import/artists', { method: 'POST', body: batch(['id', 'name'], [['a1', 'One'], ['a2', 'Two']]) });
  await call('/_workers/import/artists?replace=1', { method: 'POST', body: batch(['id', 'name'], [['a3', 'Three']]) });
  assert.deepEqual(taste.db.prepare('SELECT id FROM artists').all(), [{ id: 'a3' }]);
});

test('a child row may arrive before its parent, because the dump was never checked against its foreign keys', async () => {
  const { call, taste } = setup();
  const child = await call('/_workers/import/liked_tracks', { method: 'POST', body: batch(['track_id', 'added_at'], [['t-orphan', '2026-01-01']]) });
  assert.equal(child!.status, 200);
  assert.equal(taste.db.prepare('SELECT COUNT(*) AS n FROM liked_tracks').get()!.n, 1);
  // Enforcement is back on afterwards.
  assert.throws(() => taste.db.prepare("INSERT INTO liked_tracks (track_id, added_at) VALUES ('t-other', 'x')").run(), /FOREIGN KEY/);
});

test('a bad import is refused whole, with the reason, and writes nothing', async () => {
  const { call, taste } = setup();
  const bad = async (path: string, body: string) => ({ status: (await call(path, { method: 'POST', body }))!.status });
  assert.deepEqual(await bad('/_workers/import/nope', batch(['id'], [['x']])), { status: 404 });
  assert.deepEqual(await bad('/_workers/import/artists', 'not json'), { status: 400 });
  assert.deepEqual(await bad('/_workers/import/artists', batch(['id', 'ghost'], [['x', 'y']])), { status: 400 });
  assert.deepEqual(await bad('/_workers/import/artists', batch(['id', 'name'], [['x']])), { status: 400 });
  assert.deepEqual(await bad('/_workers/import/artists', batch(['id', 'name'], [['x', { nested: true }]])), { status: 400 });
  assert.deepEqual(await bad('/_workers/import/sqlite_master', batch(['name'], [['x']])), { status: 404 });
  assert.equal(taste.db.prepare('SELECT COUNT(*) AS n FROM artists').get()!.n, 0);
});

test('status lists every table with its columns and count; the schema route lists the statements', async () => {
  const { call } = setup();
  await call('/_workers/import/artists', { method: 'POST', body: batch(['id', 'name'], [['a1', 'One']]) });
  const status = await (await call('/_workers/status'))!.json() as { tables: Record<string, number>; columns: Record<string, string[]>; spotifyTokens: boolean };
  assert.equal(status.tables.artists, 1);
  assert.equal(status.tables.app_likes, 0);
  assert.ok(status.columns.artists.includes('followers'));
  assert.equal(status.spotifyTokens, false);
  const { statements } = await (await call('/_workers/schema'))!.json() as { statements: { name: string; table: string; sql: string }[] };
  assert.ok(statements.some((s) => s.name === 'artists' && /CREATE TABLE/.test(s.sql)));
  assert.ok(statements.some((s) => s.name === 'idx_tracks_album'));
});

test('Spotify tokens are stored through the files folder, validated, and never echoed', async () => {
  const { call, kept } = setup();
  const refused = await call('/_workers/spotify-tokens', { method: 'PUT', body: JSON.stringify({ access_token: 'a' }) });
  assert.equal(refused!.status, 400);
  const tokens = { access_token: 'a', refresh_token: 'r', expires_at: 5 };
  const saved = await call('/_workers/spotify-tokens', { method: 'PUT', body: JSON.stringify(tokens) });
  assert.deepEqual(await saved!.json(), { saved: true });
  assert.deepEqual(JSON.parse(kept.get('http://disk/spotify-tokens.json')!), tokens);
  const status = await (await call('/_workers/status'))!.text();
  assert.ok(status.includes('"spotifyTokens":true') && !status.includes('"r"'));
});
