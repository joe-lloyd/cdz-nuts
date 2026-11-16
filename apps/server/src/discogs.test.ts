import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DiscogsClient, DiscogsError, ShelfStore, albumKey, durationMs, toShelfItem } from './discogs.ts';

const withShelf = (fn: (shelf: ShelfStore) => void): void => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shelf-'));
  const shelf = new ShelfStore(path.join(dir, 'discogs.db'));
  try {
    fn(shelf);
  } finally {
    shelf.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

const release = (id: number, artist: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  basic_information: {
    id,
    title,
    year: 1990,
    thumb: 'https://img/t.jpg',
    cover_image: 'https://img/c.jpg',
    artists: [{ name: artist }],
    labels: [{ name: 'Def American', catno: '7599-24307-2' }],
    formats: [{ name: 'CD', qty: '1', descriptions: ['Album', 'CD'] }],
    genres: ['Rock'],
    ...over,
  },
});

test('collection entries flatten into shelf items', () => {
  const item = toShelfItem(release(123, 'Slayer (2)', 'Seasons in the Abyss'));
  assert.equal(item.release_id, 123);
  // Discogs disambiguates same-named artists with a trailing number.
  assert.equal(item.artist, 'Slayer');
  assert.equal(item.title, 'Seasons in the Abyss');
  assert.equal(item.year, 1990);
  assert.equal(item.catno, '7599-24307-2');
  // "CD" appears as both the format name and a description; not twice.
  assert.equal(item.format, 'CD, Album');
  assert.equal(item.genres, '["Rock"]');
});

test('album keys survive the edition noise Discogs titles carry', () => {
  const bare = albumKey('Slayer', 'Seasons in the Abyss');
  assert.equal(albumKey('Slayer', 'Seasons in the Abyss (Remastered)'), bare);
  assert.equal(albumKey('Slayer', 'Seasons in the Abyss [Deluxe Edition]'), bare);
  assert.equal(albumKey('Slayer & Friends', 'Seasons in the Abyss'), bare);
  assert.equal(albumKey('', 'Seasons in the Abyss'), '');
});

test('sync adds, refreshes, and reports what changed', () => {
  withShelf((shelf) => {
    let result = shelf.sync([release(1, 'Slayer', 'Reign in Blood'), release(2, 'Tool', 'Ænima')], 'joe');
    assert.deepEqual(result, { added: 2, updated: 0, removed: 0 });
    assert.equal(shelf.list().length, 2);

    result = shelf.sync([release(1, 'Slayer', 'Reign in Blood (Remastered)'), release(2, 'Tool', 'Ænima')], 'joe');
    assert.deepEqual(result, { added: 0, updated: 2, removed: 0 });
    assert.equal(shelf.get(1)?.title, 'Reign in Blood (Remastered)');

    const sync = shelf.lastSync();
    assert.equal(sync.username, 'joe');
    assert.equal(sync.released, 2);
  });
});

test('a sync never overwrites the status the user set', () => {
  withShelf((shelf) => {
    shelf.sync([release(1, 'Slayer', 'Reign in Blood')], 'joe');
    shelf.setStatus(1, 'ripped', '/data/library/music/Slayer/Reign in Blood (1986) [Album]');
    shelf.sync([release(1, 'Slayer', 'Reign in Blood')], 'joe');
    const item = shelf.get(1);
    assert.equal(item?.status, 'ripped');
    assert.equal(item?.rip_path, '/data/library/music/Slayer/Reign in Blood (1986) [Album]');
  });
});

test('discs that leave the collection are dropped unless already ripped', () => {
  withShelf((shelf) => {
    shelf.sync([release(1, 'Slayer', 'Reign in Blood'), release(2, 'Tool', 'Ænima')], 'joe');
    shelf.setStatus(1, 'ripped');
    // Both gone from Discogs: the ripped one is still in the library, so it
    // stays; the unripped one is genuinely gone.
    const result = shelf.sync([], 'joe');
    assert.equal(result.removed, 1);
    assert.ok(shelf.get(1));
    assert.equal(shelf.get(2), null);
  });
});

test('reconcile flips shelf discs the library has grown, and only those', () => {
  withShelf((shelf) => {
    shelf.sync([
      release(1, 'Slayer', 'Reign in Blood'),
      release(2, 'Tool', 'Ænima'),
      release(3, 'Nirvana', 'Bleach'),
    ], 'joe');
    shelf.setStatus(3, 'skip');
    const inLibrary = new Set([albumKey('Slayer', 'Reign in Blood'), albumKey('Nirvana', 'Bleach')]);
    assert.equal(shelf.reconcile(inLibrary), 1);
    assert.equal(shelf.get(1)?.status, 'ripped');
    assert.equal(shelf.get(2)?.status, 'shelf');
    // An explicit skip is the user's decision and must survive reconciliation.
    assert.equal(shelf.get(3)?.status, 'skip');
  });
});

test('setStatus rejects a status the schema would not accept', () => {
  withShelf((shelf) => {
    shelf.sync([release(1, 'Slayer', 'Reign in Blood')], 'joe');
    assert.throws(() => shelf.setStatus(1, 'melted' as 'shelf'), /unknown status/);
  });
});

test('single adds and removals work without a collection sync', () => {
  withShelf((shelf) => {
    assert.equal(shelf.add(release(9, 'Portishead', 'Dummy'))?.title, 'Dummy');
    assert.equal(shelf.list().length, 1);
    assert.equal(shelf.remove(9), true);
    assert.equal(shelf.remove(9), false);
  });
});

// A stand-in for fetch that answers by path and records what was asked.
const fakeDiscogs = (answer: (url: URL) => Response | Promise<Response>) => {
  const asked: { url: URL; authorization: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    return answer(url);
  }) as typeof fetch;
  return { asked, fetcher };
};
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('catalogue search returns artists and albums, folding pressings into their master', async () => {
  const { asked, fetcher } = fakeDiscogs((url) => {
    const type = url.searchParams.get('type');
    if (type === 'artist') return reply({ results: [{ id: 77, type: 'artist', title: 'The Quiet Ferns (2)', cover_image: 'https://i/ferns.jpg' }] });
    if (type === 'master') return reply({ results: [{ id: 501, type: 'master', title: 'The Quiet Ferns (2) - Hollow Lanterns', year: '2019', genre: ['Rock'], cover_image: 'https://i/hl.jpg' }] });
    return reply({ results: [
      { id: 9001, type: 'release', master_id: 501, title: 'The Quiet Ferns - Hollow Lanterns', year: '2020' },
      { id: 9002, type: 'release', master_id: 0, title: 'The Quiet Ferns - Demo Tape', year: '2017', format: ['Cassette'] },
    ] });
  });
  const client = new DiscogsClient('secret-token', '', '', { api: 'https://discogs.test', fetch: fetcher });
  const found = await client.searchCatalogue('quiet ferns');
  assert.deepEqual(found.artists, [{ id: 77, name: 'The Quiet Ferns', image: 'https://i/ferns.jpg' }]);
  assert.deepEqual(found.albums.map((album) => `${album.kind}:${album.id}:${album.artist}:${album.title}`), [
    'master:501:The Quiet Ferns:Hollow Lanterns',
    'release:9002:The Quiet Ferns:Demo Tape',
  ]);
  assert.equal(asked.length, 3);
  assert(asked.every((call) => call.url.origin === 'https://discogs.test' && call.authorization === 'Discogs token=secret-token'));
  // A repeat of the same search is answered from the cache.
  await client.searchCatalogue('quiet ferns');
  assert.equal(asked.length, 3);
});

test('an interactive call fails fast on a rate limit, with the wait in the message', async () => {
  const { asked, fetcher } = fakeDiscogs(() => reply({ message: 'slow down' }, 429, { 'retry-after': '12' }));
  const client = new DiscogsClient('t', '', '', { api: 'https://discogs.test', fetch: fetcher });
  const started = Date.now();
  await assert.rejects(client.album('master', 1), (err: unknown) =>
    err instanceof DiscogsError && err.status === 429 && /Try again in 12 seconds/.test(err.message));
  assert.equal(asked.length, 1);
  assert(Date.now() - started < 1000);
});

test('an outage or a network failure reads as Discogs being unavailable, and never echoes the token', async () => {
  const down = new DiscogsClient('secret-token', '', '', { api: 'https://discogs.test', fetch: fakeDiscogs(() => reply({}, 503)).fetcher });
  await assert.rejects(down.artist(1), (err: unknown) => err instanceof DiscogsError && err.status === 502 && err.message === 'Discogs is unavailable right now');
  const offline = new DiscogsClient('secret-token', '', '', {
    api: 'https://discogs.test',
    fetch: (async () => { throw new TypeError('fetch failed: secret-token'); }) as typeof fetch,
  });
  await assert.rejects(offline.artist(1), (err: unknown) =>
    err instanceof DiscogsError && err.status === 502 && !err.message.includes('secret-token'));
  const missing = new DiscogsClient('t', '', '', { api: 'https://discogs.test', fetch: fakeDiscogs(() => reply({}, 404)).fetcher });
  await assert.rejects(missing.album('release', 5), (err: unknown) => err instanceof DiscogsError && err.status === 404);
});

test('without credentials nothing is sent and the error says Discogs is not configured', async () => {
  const { asked, fetcher } = fakeDiscogs(() => reply({}));
  const client = new DiscogsClient('', '', '', { api: 'https://discogs.test', fetch: fetcher });
  await assert.rejects(client.searchCatalogue('anything'), (err: unknown) =>
    err instanceof DiscogsError && err.status === 503 && /not configured/.test(err.message));
  assert.equal(asked.length, 0);
});

test('a master is completed with its main release label when added', async () => {
  const { asked, fetcher } = fakeDiscogs((url) => url.pathname === '/masters/501'
    ? reply({ id: 501, title: 'Hollow Lanterns', year: 2019, main_release: 9001, artists: [{ id: 77, name: 'The Quiet Ferns' }], tracklist: [{ position: '1', title: 'Moth Light', duration: '4:05' }] })
    : reply({ id: 9001, master_id: 501, title: 'Hollow Lanterns', released: '2019-04-12', labels: [{ name: 'Fern Records' }], formats: [{ name: 'CD', descriptions: ['Album'] }] }));
  const client = new DiscogsClient('t', '', '', { api: 'https://discogs.test', fetch: fetcher });
  const album = await client.albumForLibrary('master', 501);
  assert.equal(album.label, 'Fern Records');
  assert.equal(album.released, '2019-04-12');
  assert.deepEqual(album.tracks, [{ position: '1', title: 'Moth Light', durationMs: 245000, artists: [] }]);
  assert.deepEqual(asked.map((call) => call.url.pathname), ['/masters/501', '/releases/9001']);
});

test('an artist discography keeps main credits only', async () => {
  const { fetcher } = fakeDiscogs(() => reply({ releases: [
    { id: 501, type: 'master', title: 'Hollow Lanterns', year: 2019, artist: 'The Quiet Ferns', role: 'Main', thumb: 'https://i/t.jpg' },
    { id: 7, type: 'release', title: 'Somebody Else', year: 2018, artist: 'Other Band', role: 'Appearance' },
  ] }));
  const client = new DiscogsClient('t', '', '', { api: 'https://discogs.test', fetch: fetcher });
  assert.deepEqual((await client.artistAlbums(77)).map((album) => `${album.kind}:${album.id}`), ['master:501']);
});

test('track durations parse minutes and hours, and blank stays unknown', () => {
  assert.equal(durationMs('4:05'), 245000);
  assert.equal(durationMs('1:02:03'), 3723000);
  assert.equal(durationMs(''), null);
  assert.equal(durationMs('4:x5'), null);
});
