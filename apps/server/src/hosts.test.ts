// The same app on both SQL hosts, side by side: node:sqlite files, and the
// single database of a Durable Object (on the fake storage). Both start from the
// fictional world in scripts/fake-data.ts and answer the same requests through
// handle(), the fetch handler the Node server and the Worker share. Where the
// answers differ, one host is not the other. workerd itself is not involved, so
// this runs in CI; the HomeLab repo's verify.mjs runs the real thing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { handleAdmin } from './admin.ts';
import { AlbumGroupStore } from './album-groups.ts';
import { TasteDb } from './db.ts';
import { fakeDisk } from './fake-disk.ts';
import { fakeDurableObjectStorage } from './fake-do.ts';
import { diskFiles } from './files.ts';
import { nodeFiles } from './files-node.ts';
import { provideRuntime, type Runtime } from './runtime.ts';
import { durableObjectSql } from './sql-do.ts';
import { nodeSql } from './sql-node.ts';
import { nodeUi } from './ui-node.ts';

const ROUTES = [
  '/api/ui-build', '/api/stats', '/api/overview', '/api/artists', '/api/albums', '/api/tracks', '/api/local-tracks', '/api/library-albums', '/api/releases',
  '/api/albums-all?limit=5&offset=3', '/api/playlists', '/api/events', '/api/lidarr-list', '/api/plays', '/api/latest', '/api/provenance',
  '/api/top-artists?range=short_term', '/api/top-tracks?range=long_term', '/api/wrapped', '/api/wrapped?from=2025-03&to=2025-06', '/api/songs?q=part&limit=10',
  '/api/search?q=night', `/api/search?q=${'night '.repeat(14)}`, `/api/songs?q=${'part '.repeat(14)}`, '/api/artist-search?name=mira', '/api/upgrades', '/api/albums/wants', '/api/playlist-tracks?id=pl01', '/api/playlist-tracks?id=local-playlist:voyage35',
  '/api/album?id=al01', '/api/album?id=al13', '/api/artist?id=ar01', '/api/artist?id=ar02', '/api/artist?id=ar11', '/', '/album/al01', '/img/albums/al01.jpg', '/img/folder?rel=Yppah',
  '/img/folder?rel=Local%20Signals%2FNight%20Drive%20(2018)%20%5BAlbum%5D', '/img/folder?rel=..%2F..', '/api/nothing',
];
const WRITES: [string, unknown][] = [
  ['/api/likes', { id: 'al05t1', liked: true }], ['/api/player/played', { id: 'al01t1', msPlayed: 61_000, completed: true }],
  ['/api/local-playlists', { name: 'Road trip', trackIds: ['al01t1', 'al02t2'] }], ['/api/upgrades', { sourceUrl: 'https://youtu.be/q1', artist: 'Test Artist', title: 'Test One' }],
];

async function answers(handle: (r: Request) => Promise<Response>): Promise<string[]> {
  const out: string[] = [];
  const settle = async (response: Response) => {
    const text = await response.text();
    // Anything made while the test ran (ids, times) is masked, as the real comparison does.
    return `${response.status} ${response.headers.get('content-type')} ${text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/20\d\d-\d\d-\d\dT[\d:.]+Z/g, (t) => (Date.parse(t) > Date.now() - 600_000 ? '<now>' : t))}`;
  };
  for (const route of ROUTES) out.push(`GET ${route} ${await settle(await handle(new Request(`http://app${route}`)))}`);
  for (const [route, body] of WRITES) out.push(`POST ${route} ${await settle(await handle(new Request(`http://app${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })))}`);
  for (const route of ['/api/albums', '/api/playlists', '/api/upgrades', '/api/overview', '/api/plays', '/api/stats']) out.push(`AFTER ${route} ${await settle(await handle(new Request(`http://app${route}`)))}`);
  return out;
}

test('the routes answer the same from node:sqlite files and from a Durable Object database', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hosts-'));
  // Some routes start background lookups at MusicBrainz; the house is offline for this test.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  try {
    const made = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(import.meta.dirname, '..', 'scripts', 'fake-data.ts'), dir], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const data = path.join(dir, 'data');
    const env = (names: Record<string, string>) => Object.assign(process.env, {
      APP_LIBRARY_PREFIX: path.join(dir, 'library'), TZ: 'Europe/Amsterdam',
      JELLYFIN_URL: '', JELLYFIN_API_KEY: '', MUSIC_SOURCE_HOST: '', LISTENBRAINZ_TOKEN: '', DISCOGS_TOKEN: '', UPGRADE_WORKER_TOKEN: '',
    }, names);
    const ui = await nodeUi();
    const probe = async () => false;

    // Host one: the files, as the Node server has them. Copied first so the writes do not touch the other host's start.
    const files = ['spotify', 'provenance', 'upgrades', 'app-plays', 'likes', 'playlists', 'lyrics', 'listenbrainz', 'discogs'].map((n) => path.join(data, `${n}.db`));
    const nodeData = path.join(dir, 'node-data');
    spawnSync('cp', ['-R', data, nodeData]);
    const at = (n: string) => path.join(nodeData, `${n}.db`);
    env({ SPOTIFY_DB: at('spotify'), PROVENANCE_DB: at('provenance'), UPGRADES_DB: at('upgrades'), APP_PLAYS_DB: at('app-plays'), LIKES_DB: at('likes'), PLAYLISTS_DB: at('playlists'), LYRICS_DB: at('lyrics'), DISCOGS_DB: at('discogs'), LISTENBRAINZ_DB: at('listenbrainz'), IMAGES_DIR: path.join(nodeData, 'images') });
    provideRuntime({ sql: nodeSql, files: nodeFiles, ui, probe } satisfies Runtime);
    const nodeApp = await import('./app.ts?host=node');
    nodeApp.init();
    const onNode = await answers(nodeApp.handle);

    // Host two: one Durable Object database, filled the way move.mjs fills the Worker, and the disk bindings.
    const sql = durableObjectSql(fakeDurableObjectStorage());
    env({ SPOTIFY_DB: 'spotify', PROVENANCE_DB: 'provenance', UPGRADES_DB: 'upgrades', APP_PLAYS_DB: 'app-plays', LIKES_DB: 'likes', PLAYLISTS_DB: 'playlists', LYRICS_DB: 'lyrics', DISCOGS_DB: 'discogs', LISTENBRAINZ_DB: 'listenbrainz', IMAGES_DIR: '/images' });
    provideRuntime({
      sql, ui, probe,
      files: diskFiles([{ prefix: path.join(dir, 'library'), disk: fakeDisk(path.join(dir, 'library')) }, { prefix: '/images', disk: fakeDisk(path.join(data, 'images')) }]),
    });
    // What the Worker builds before the app: the tables the exporter and the grouping module own.
    new TasteDb('spotify');
    new AlbumGroupStore('spotify');
    const doApp = await import('./app.ts?host=durable-object');
    doApp.init();
    const admin = { sql: sql.open('x'), token: 't', state: { fetch: async () => new Response('no', { status: 404 }) }, nightly: { start: () => true, status: () => ({ running: false, startedAt: null, finishedAt: null, errors: [] }) } };
    for (const file of files) {
      const db = new DatabaseSync(file, { readOnly: true });
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all() as { name: string }[]) {
        const columns = (db.prepare('SELECT name FROM pragma_table_info(?)').all(name) as { name: string }[]).map((c) => c.name);
        const rows = db.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(',')} FROM "${name}"`).all().map((r) => columns.map((c) => (r as Record<string, unknown>)[c]));
        if (!rows.length) continue;
        const response = await handleAdmin(new Request(`http://x/_workers/import/${name}?replace=1`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify({ columns, rows }) }), admin);
        assert.equal(response!.status, 200, `${name}: ${await response!.text()}`);
      }
      db.close();
    }
    const onDurableObject = await answers(doApp.handle);

    assert.equal(onNode.length, onDurableObject.length);
    for (const [i, line] of onNode.entries()) {
      assert.equal(onDurableObject[i], line, `${line.slice(0, 60)} differs between the hosts`);
    }
    assert.ok(onNode.filter((l) => l.includes(' 200 ')).length > 30, 'most routes answered 200');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
