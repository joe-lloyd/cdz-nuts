// The nightly export end to end, against a stand-in for Spotify and the other
// services it calls, writing into a database, a disk binding and a token store
// that are not on node's disk. It runs the same code the Worker runs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureAuth, type TokenSet, type TokenStore } from './auth.ts';
import { TasteDb } from './db.ts';
import { fakeDurableObjectStorage } from './fake-do.ts';
import { fakeDisk } from './fake-disk.ts';
import { runExport } from './exporter.ts';
import { diskFiles } from './files.ts';
import { provideSql } from './sql.ts';
import { durableObjectSql } from './sql-do.ts';

const artist = { id: 'ar1', name: 'Mira Vale', genres: ['art pop'], popularity: 60, followers: { total: 1200 }, images: [{ url: 'https://i.scdn.co/artist1' }] };
const album = { id: 'al1', name: 'Afterimage', album_type: 'album', release_date: '2026-05-01', release_date_precision: 'day', total_tracks: 1, label: 'Violet', popularity: 50, images: [{ url: 'https://i.scdn.co/album1' }], artists: [artist] };
const track = { id: 't1', name: 'Blue Room', album, artists: [artist], disc_number: 1, track_number: 1, duration_ms: 200_000, explicit: false, popularity: 40 };
const page = (items: unknown[]) => ({ items, next: null, total: items.length });

function spotify(calls: string[]) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.host === 'accounts.spotify.com') return json({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 });
    if (url.host === 'i.scdn.co') return new Response(`image:${url.pathname}`);
    if (url.host === 'musicbrainz.org') return json({ artists: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Mira Vale', score: 100 }] });
    assert.equal(url.host, 'api.spotify.com', `unexpected call to ${url.host}`);
    switch (url.pathname) {
      case '/v1/me': return json({ id: 'joe', display_name: 'Joe' });
      case '/v1/me/tracks': return json(page([{ added_at: '2026-06-01T10:00:00Z', track }]));
      case '/v1/me/albums': return json(page([{ added_at: '2026-06-02T10:00:00Z', album: { ...album, tracks: page([track]) } }]));
      case '/v1/me/following': return json({ artists: page([artist]) });
      case '/v1/me/playlists': return json(page([]));
      case '/v1/me/top/artists': return json(page([artist]));
      case '/v1/me/top/tracks': return json(page([track]));
      case '/v1/me/player/recently-played': return json({ items: [{ played_at: '2026-10-12T09:00:00Z', track, context: { type: 'album', uri: 'spotify:album:al1' } }] });
      case '/v1/artists/ar1': return json(artist);
      case '/v1/albums/al1': return json({ ...album, tracks: page([track]) });
      case '/v1/artists/ar1/albums': return json(page([{ ...album, album_group: 'album' }, { ...album, id: 'al2', name: 'Fresh Out', release_date: new Date().toISOString().slice(0, 10), album_group: 'single' }]));
      default: return json({ message: `no stand-in for ${url.pathname}` }, 404);
    }
  };
}

test('the export writes Spotify into the database, the covers onto the disk, and rotates the token', async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'export-'));
  const saved: TokenSet[] = [];
  const tokens: TokenStore = {
    async load() { return { access_token: 'stale', refresh_token: 'refresh-1', expires_at: Date.now() - 1_000 }; },
    async save(next) { saved.push(next); },
  };
  globalThis.fetch = spotify(calls) as typeof fetch;
  try {
    provideSql(durableObjectSql(fakeDurableObjectStorage()));
    const db = new TasteDb('spotify');
    configureAuth({ clientId: 'client', store: tokens });
    const files = diskFiles([{ prefix: '/images', disk: fakeDisk(dir) }]);
    await runExport(db, { files, imagesDir: '/images', label: 'test' });

    const rows = (sql: string) => db.db.prepare(sql).all();
    assert.deepEqual(rows('SELECT id, name, is_followed FROM artists'), [{ id: 'ar1', name: 'Mira Vale', is_followed: 1 }]);
    assert.deepEqual(rows('SELECT id, is_saved FROM albums ORDER BY id'), [{ id: 'al1', is_saved: 1 }, { id: 'al2', is_saved: 0 }]);
    assert.deepEqual(rows('SELECT track_id FROM liked_tracks'), [{ track_id: 't1' }]);
    assert.deepEqual(rows('SELECT track_id FROM plays'), [{ track_id: 't1' }]);
    assert.deepEqual(rows('SELECT time_range, rank FROM top_tracks ORDER BY time_range'), [
      { time_range: 'long_term', rank: 1 }, { time_range: 'medium_term', rank: 1 }, { time_range: 'short_term', rank: 1 },
    ]);
    assert.deepEqual(rows('SELECT artist_id, mbid, method FROM artist_mbid'), [{ artist_id: 'ar1', mbid: '00000000-0000-4000-8000-000000000001', method: 'name' }]);
    const run = db.db.prepare('SELECT finished_at, summary FROM sync_runs').get()!;
    assert.ok(run.finished_at, 'the run is marked finished');
    assert.equal((JSON.parse(String(run.summary)) as { liked_tracks: number }).liked_tracks, 1);

    // The covers went through the disk binding to the folder it serves.
    assert.equal(readFileSync(path.join(dir, 'albums', 'al1.jpg'), 'utf8'), 'image:/album1');
    assert.equal(readFileSync(path.join(dir, 'artists', 'ar1.jpg'), 'utf8'), 'image:/artist1');
    assert.equal(readFileSync(path.join(dir, 'albums', 'al2.jpg'), 'utf8'), 'image:/album1');

    // The refresh token was rotated and saved before the first API call used it.
    assert.deepEqual(saved.map((t) => [t.access_token, t.refresh_token]), [['fresh', 'rotated']]);
    assert.ok(calls.indexOf('POST accounts.spotify.com/api/token') < calls.indexOf('GET api.spotify.com/v1/me'));

    // Run again: nothing is downloaded twice.
    const before = calls.filter((c) => c.startsWith('GET i.scdn.co')).length;
    await runExport(db, { files, imagesDir: '/images', label: 'test' });
    assert.equal(calls.filter((c) => c.startsWith('GET i.scdn.co')).length, before, 'archived covers are not fetched again');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no tokens stored and nobody to sign in, the export stops and says why', async () => {
  const db = (() => { provideSql(durableObjectSql(fakeDurableObjectStorage())); return new TasteDb('spotify'); })();
  configureAuth({ clientId: 'client', store: { load: async () => null, save: async () => {} } });
  await assert.rejects(runExport(db, { files: diskFiles([]), imagesDir: '/images', label: 'x' }), /cannot sign in/);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get()!.n, 0, 'no run is recorded before the sign-in');
});
