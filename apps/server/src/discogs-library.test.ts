import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TasteDb } from './db.ts';
import { toDiscogsAlbum, type DiscogsAlbum } from './discogs.ts';
import { DiscogsLibrary, type HeldAlbum } from './discogs-library.ts';

const withLibrary = (fn: (taste: TasteDb, library: DiscogsLibrary, held: HeldAlbum[]) => void): void => {
  const dir = mkdtempSync(path.join(tmpdir(), 'discogs-library-'));
  const taste = new TasteDb(path.join(dir, 'spotify.db'));
  const held: HeldAlbum[] = [];
  try {
    fn(taste, new DiscogsLibrary(taste.db, () => held, () => Date.parse('2026-11-16T12:00:00Z')), held);
  } finally {
    taste.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

// The shape /masters/{id} answers with, trimmed to the fields that matter.
const master = (over: Record<string, unknown> = {}): DiscogsAlbum => toDiscogsAlbum('master', {
  id: 501,
  title: 'Hollow Lanterns',
  year: 2019,
  main_release: 9001,
  artists: [{ id: 77, name: 'The Quiet Ferns (2)' }],
  genres: ['Rock'],
  styles: ['Shoegaze'],
  images: [{ type: 'secondary', uri: 'https://i.discogs.example/back.jpg' }, { type: 'primary', uri: 'https://i.discogs.example/front.jpg' }],
  tracklist: [
    { position: '1', title: 'Moth Light', duration: '4:05', type_: 'track' },
    { position: '', title: 'Bonus', type_: 'heading' },
    { position: '2', title: 'Undertow', duration: '', type_: 'track', artists: [{ id: 88, name: 'Guest Singer' }] },
    { position: '3', title: 'Suite', type_: 'index', sub_tracks: [
      { position: '3a', title: 'Suite I', duration: '1:02:03', type_: 'track' },
    ] },
  ],
  ...over,
});

const count = (taste: TasteDb, table: string, where = '1=1', ...args: string[]): number =>
  Number((taste.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n);

test('a Discogs master becomes a saved album with its artist and tracks', () => {
  withLibrary((taste, library) => {
    const result = library.addAlbum(master());
    assert.deepEqual(result, {
      albumId: 'discogs-master:501', added: true, artistIds: ['discogs-artist:77'], addedArtists: 2, tracks: 3,
    });
    const album = taste.db.prepare('SELECT * FROM albums WHERE id = ?').get('discogs-master:501') as Record<string, unknown>;
    assert.equal(album.name, 'Hollow Lanterns');
    assert.equal(album.is_saved, 1);
    assert.equal(album.saved_at, '2026-11-16T12:00:00.000Z');
    assert.equal(album.release_date, '2019');
    assert.equal(album.release_date_precision, 'year');
    assert.equal(album.image_url, 'https://i.discogs.example/front.jpg');
    assert.equal(album.album_type, 'album');
    // The disambiguating "(2)" is Discogs' bookkeeping, not the band's name.
    assert.equal((taste.db.prepare('SELECT name FROM artists WHERE id = ?').get('discogs-artist:77') as { name: string }).name, 'The Quiet Ferns');
    const tracks = taste.db.prepare('SELECT name, disc_number, track_number, duration_ms FROM tracks WHERE album_id = ? ORDER BY track_number').all('discogs-master:501');
    // Headings are dropped and index sub-tracks are kept.
    assert.deepEqual(tracks.map((row) => ({ ...row })), [
      { name: 'Moth Light', disc_number: 1, track_number: 1, duration_ms: 245000 },
      { name: 'Undertow', disc_number: 1, track_number: 2, duration_ms: null },
      { name: 'Suite I', disc_number: 1, track_number: 3, duration_ms: 3723000 },
    ]);
    // The guest is credited on their track, the band on the others.
    const credits = taste.db.prepare(`SELECT t.name, ta.artist_id FROM track_artists ta JOIN tracks t ON t.id = ta.track_id ORDER BY t.track_number`).all();
    assert.deepEqual(credits.map((row) => ({ ...row })), [
      { name: 'Moth Light', artist_id: 'discogs-artist:77' },
      { name: 'Undertow', artist_id: 'discogs-artist:88' },
      { name: 'Suite I', artist_id: 'discogs-artist:77' },
    ]);
  });
});

test('adding the same album twice writes nothing the second time', () => {
  withLibrary((taste, library) => {
    library.addAlbum(master());
    const before = ['artists', 'albums', 'tracks', 'album_artists', 'track_artists'].map((table) => count(taste, table));
    const again = library.addAlbum(master());
    assert.deepEqual(again, { albumId: 'discogs-master:501', added: false, artistIds: [], addedArtists: 0, tracks: 0 });
    assert.deepEqual(['artists', 'albums', 'tracks', 'album_artists', 'track_artists'].map((table) => count(taste, table)), before);
  });
});

test('a release of an album already added as a master is the same album', () => {
  withLibrary((taste, library) => {
    library.addAlbum(master());
    const pressing = toDiscogsAlbum('release', {
      id: 9001, master_id: 501, title: 'Hollow Lanterns (Deluxe Edition)', year: 2020,
      artists: [{ id: 77, name: 'The Quiet Ferns (2)' }], tracklist: [{ position: '1', title: 'Moth Light' }],
    });
    assert.equal(library.findAlbum('release', 9001, ['The Quiet Ferns'], pressing.title, 501), 'discogs-master:501');
    assert.equal(library.addAlbum(pressing).added, false);
    assert.equal(count(taste, 'albums'), 1);
  });
});

test('a release first added on its own is stored as its master', () => {
  withLibrary((taste, library) => {
    const pressing = toDiscogsAlbum('release', {
      id: 9001, master_id: 501, title: 'Hollow Lanterns', released: '2019-04-12', year: 2019,
      labels: [{ name: 'Fern Records' }], formats: [{ name: 'CD', descriptions: ['Album'] }],
      artists: [{ id: 77, name: 'The Quiet Ferns' }], tracklist: [{ position: '1', title: 'Moth Light' }],
    });
    const added = library.addAlbum(pressing);
    assert.equal(added.albumId, 'discogs-master:501');
    const album = taste.db.prepare('SELECT label, release_date, release_date_precision FROM albums WHERE id = ?').get(added.albumId);
    assert.deepEqual({ ...album }, { label: 'Fern Records', release_date: '2019-04-12', release_date_precision: 'day' });
    // The master, found later in search, is already held.
    assert.equal(library.findAlbum('master', 501, ['The Quiet Ferns'], 'Hollow Lanterns'), 'discogs-master:501');
  });
});

test('an artist the library already knows from Spotify is reused, not doubled', () => {
  withLibrary((taste, library) => {
    taste.db.prepare("INSERT INTO artists (id, name, is_followed) VALUES ('spotify-ferns', 'the quiet ferns', 1)").run();
    const added = library.addAlbum(master({ tracklist: [{ position: '1', title: 'Moth Light' }] }));
    assert.deepEqual(added.artistIds, ['spotify-ferns']);
    assert.equal(added.addedArtists, 0);
    assert.equal(count(taste, 'artists', "id LIKE 'discogs-%'"), 0);
    assert.equal(library.findArtist({ id: 77, name: 'The Quiet Ferns (2)' }), 'spotify-ferns');
  });
});

test('an album Spotify already lists for the artist is not offered or added again', () => {
  withLibrary((taste, library) => {
    taste.db.prepare("INSERT INTO artists (id, name) VALUES ('sp-ferns', 'The Quiet Ferns')").run();
    taste.db.prepare("INSERT INTO albums (id, name, is_saved) VALUES ('sp-lanterns', 'Hollow Lanterns (Remastered)', 1)").run();
    taste.db.prepare("INSERT INTO album_artists VALUES ('sp-lanterns', 'sp-ferns', 0)").run();
    assert.equal(library.findAlbum('master', 501, ['The Quiet Ferns (2)'], 'Hollow Lanterns'), 'sp-lanterns');
    const added = library.addAlbum(master());
    assert.deepEqual(added, { albumId: 'sp-lanterns', added: false, artistIds: [], addedArtists: 0, tracks: 0 });
    assert.equal(count(taste, 'albums'), 1);
    assert.equal(count(taste, 'tracks'), 0);
  });
});

test('albums and artists held only on disk count as held', () => {
  withLibrary((taste, library, held) => {
    held.push({ id: 'lib:ferns-lanterns', name: 'Hollow Lanterns', artists: 'The Quiet Ferns' });
    assert.equal(library.findAlbum('master', 501, ['The Quiet Ferns'], 'Hollow Lanterns'), 'lib:ferns-lanterns');
    assert.equal(library.findArtist({ id: 77, name: 'The Quiet Ferns' }), 'local-artist:The Quiet Ferns');
    assert.equal(library.addAlbum(master()).added, false);
    // A different album by an artist known only from disk gets a real row to link to.
    const other = library.addAlbum(master({ id: 502, title: 'Second Bloom', tracklist: [] }));
    assert.equal(other.added, true);
    assert.deepEqual(other.artistIds, ['discogs-artist:77']);
    assert.equal(count(taste, 'albums'), 1);
  });
});

test('an artist added on its own is written once', () => {
  withLibrary((taste, library) => {
    assert.deepEqual(library.addArtist({ id: 77, name: 'The Quiet Ferns (2)', image: 'https://i.discogs.example/ferns.jpg' }),
      { artistId: 'discogs-artist:77', added: true });
    assert.deepEqual(library.addArtist({ id: 77, name: 'The Quiet Ferns' }), { artistId: 'discogs-artist:77', added: false });
    assert.equal(count(taste, 'artists'), 1);
    const row = taste.db.prepare('SELECT name, image_url, genres, is_followed FROM artists').get();
    // genres is set (to []), so the Spotify hydrator would never mistake it for a stub.
    assert.deepEqual({ ...row }, { name: 'The Quiet Ferns', image_url: 'https://i.discogs.example/ferns.jpg', genres: '[]', is_followed: 0 });
    // Adding one of their albums later links to the same row.
    assert.deepEqual(library.addAlbum(master({ tracklist: [] })).artistIds, ['discogs-artist:77']);
  });
});

test('multi-disc positions number each disc from one', () => {
  withLibrary((taste, library) => {
    library.addAlbum(master({
      tracklist: [
        { position: '1-1', title: 'A' }, { position: '1-2', title: 'B' },
        { position: 'CD2-1', title: 'C' }, { position: '2-2', title: 'D' },
      ],
    }));
    const rows = taste.db.prepare('SELECT name, disc_number, track_number FROM tracks ORDER BY id').all();
    assert.deepEqual(rows.map((row) => `${row.name}:${row.disc_number}.${row.track_number}`), ['A:1.1', 'B:1.2', 'C:2.1', 'D:2.2']);
  });
});

const members = (taste: TasteDb): string[] =>
  (taste.db.prepare('SELECT artist_id FROM discogs_library_artists ORDER BY artist_id').all() as { artist_id: string }[])
    .map((row) => row.artist_id);

test('an artist added alone stays a library member when another album credits them on a track', () => {
  withLibrary((taste, library) => {
    library.addArtist({ id: 88, name: 'Guest Singer' });
    // master() credits Guest Singer (88) on 'Undertow' only.
    const added = library.addAlbum(master());
    assert.deepEqual(added.artistIds, ['discogs-artist:77']);
    assert.equal(count(taste, 'track_artists', "artist_id = 'discogs-artist:88'"), 1);
    assert.equal(count(taste, 'album_artists', "artist_id = 'discogs-artist:88'"), 0);
    assert.deepEqual(members(taste), ['discogs-artist:77', 'discogs-artist:88']);
  });
});

test('a guest credited only on a track gets a row but is not a library member', () => {
  withLibrary((taste, library) => {
    library.addAlbum(master());
    assert.equal(count(taste, 'artists', "id = 'discogs-artist:88'"), 1);
    assert.deepEqual(members(taste), ['discogs-artist:77']);
    // Adding them on purpose later joins them, and only once.
    assert.deepEqual(library.addArtist({ id: 88, name: 'Guest Singer' }), { artistId: 'discogs-artist:88', added: true });
    assert.deepEqual(library.addArtist({ id: 88, name: 'Guest Singer' }), { artistId: 'discogs-artist:88', added: false });
    assert.deepEqual(members(taste), ['discogs-artist:77', 'discogs-artist:88']);
  });
});

test('an album with no artist is refused rather than stored orphaned', () => {
  withLibrary((taste, library) => {
    assert.throws(() => library.addAlbum(master({ artists: [] })), /no artist/);
    assert.equal(count(taste, 'albums'), 0);
  });
});
