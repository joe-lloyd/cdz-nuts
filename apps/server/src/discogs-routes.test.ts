import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { TasteDb } from './db.ts';
import { startFakeDiscogs } from './fake-discogs.ts';
import { ShelfStore } from './discogs.ts';

const TOKEN = 'fixture-token-never-shown';

async function freePort(): Promise<number> {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return address.port;
}

/** The real server over scratch databases; Discogs credentials as given. */
async function startServer(dir: string, discogs: Record<string, string>) {
  const port = await freePort();
  const store = (name: string) => name === 'discogs' ? path.join(dir, 'discogs.db') : path.join(dir, `${name}-${port}.db`);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', path.join(import.meta.dirname, 'server.ts')], {
    env: {
      ...process.env, PORT: String(port), SPOTIFY_DB: path.join(dir, 'spotify.db'),
      PLAYLISTS_DB: store('playlists'), UPGRADES_DB: store('upgrades'), LIKES_DB: store('likes'), APP_PLAYS_DB: store('plays'),
      PROVENANCE_DB: store('provenance'), DISCOGS_DB: store('discogs'), LYRICS_DB: store('lyrics'),
      JELLYFIN_URL: '', MUSIC_SOURCE_HOST: '', LISTENBRAINZ_TOKEN: '',
      DISCOGS_TOKEN: '', DISCOGS_CONSUMER_KEY: '', DISCOGS_CONSUMER_SECRET: '', ...discogs,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Made at spawn, so stopping works however and whenever the child ended.
  const exited = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    for (let i = 0; i < 200 && !output.includes('taste-db ui on'); i++) {
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(output);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.match(output, /taste-db ui on/);
  } catch (err) {
    // A server that never came up is still a process: reap it, or the run hangs.
    await stop();
    throw err;
  }
  const base = `http://127.0.0.1:${port}`;
  const call = async (route: string, body?: unknown) => {
    const response = await fetch(base + route, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.ok(!text.includes(TOKEN), `${route} leaked the Discogs token`);
    return { status: response.status, body: JSON.parse(text) as Record<string, any> };
  };
  const ok = async (route: string, body?: unknown) => {
    const { status, body: data } = await call(route, body);
    assert.equal(status, 200, JSON.stringify(data));
    return data;
  };
  return { call, ok, stop, log: () => output };
}

test('HTTP: Discogs search, add to the library, dedupe, and failure states', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'discogs-routes-'));
  // A library with one unrelated Spotify album, so Library is not empty.
  const taste = new TasteDb(path.join(dir, 'spotify.db'));
  taste.run("INSERT INTO artists (id, name, is_followed, genres) VALUES ('sp-mira', 'Mira Vale', 1, '[]')");
  taste.run("INSERT INTO albums (id, name, is_saved, saved_at, label) VALUES ('sp-local', 'Local Signals', 1, '2026-01-01', '')");
  taste.run("INSERT INTO album_artists VALUES ('sp-local', 'sp-mira', 0)");
  taste.db.close();
  // The same album, owned on CD and waiting to be ripped.
  const shelf = new ShelfStore(path.join(dir, 'discogs.db'));
  shelf.add({ id: 9001, basic_information: { id: 9001, title: 'Hollow Lanterns', artists: [{ name: 'The Quiet Ferns (2)' }] } });
  shelf.close();
  const fake = await startFakeDiscogs();
  try {
    const server = await startServer(dir, { DISCOGS_TOKEN: TOKEN, DISCOGS_API_URL: fake.url });
    try {
      // Nothing local for a band we have never heard of.
      const before = await server.ok('/api/search?q=Quiet%20Ferns');
      assert.deepEqual([before.artists.length, before.albums.length, before.songs.length], [0, 0, 0]);

      const found = await server.ok('/api/discogs/search?q=Quiet%20Ferns');
      assert.deepEqual(found.artists, [{ id: 77, name: 'The Quiet Ferns', image: `${fake.url}/img/77.jpg`, library: null }]);
      assert.deepEqual(found.albums.map((a: any) => [a.kind, a.id, a.title, a.library]), [
        ['master', 501, 'Hollow Lanterns', null], ['master', 502, 'Second Bloom', null], ['release', 9002, 'Demo Tape', null],
      ]);
      assert(fake.requests.every(r => r.authorization === `Discogs token=${TOKEN}`), 'the server, not the browser, authenticates');

      const detail = await server.ok('/api/discogs/album?kind=master&id=501');
      assert.deepEqual(detail.album.tracks.map((t: any) => t.title), ['Moth Light', 'Undertow', 'Paper Boats', 'Lantern Song']);
      assert.equal(detail.album.library, null);
      const discography = await server.ok('/api/discogs/artist?id=77');
      assert.equal(discography.artist.name, 'The Quiet Ferns');
      assert.deepEqual(discography.albums.map((a: any) => a.title), ['Second Bloom', 'Hollow Lanterns', 'Demo Tape']);

      // Like state of the album, its artist and its tracks: an add files
      // metadata, it does not favourite anything (that would grab audio).
      const likeState = async () => {
        const albums = await server.ok('/api/albums') as unknown as { id: string; liked?: number }[];
        const artists = await server.ok('/api/artists') as unknown as { id: string; liked?: number }[];
        const liked = await server.ok('/api/tracks') as unknown as { id: string }[];
        const page = await server.ok('/api/album?id=discogs-master:501');
        return {
          album: Number(albums.find(a => a.id === 'discogs-master:501')?.liked ?? 0),
          artist: Number(artists.find(a => a.id === 'discogs-artist:77')?.liked ?? 0),
          likedTracks: liked.filter(t => String(t.id).startsWith('discogs-')).length,
          albumPageLikedTracks: (page.tracks as { liked?: number }[]).filter(t => Number(t.liked)).length,
        };
      };
      const unliked = { album: 0, artist: 0, likedTracks: 0, albumPageLikedTracks: 0 };
      assert.deepEqual(await likeState(), unliked);
      const added = await server.ok('/api/discogs/add', { kind: 'master', id: 501 });
      assert.deepEqual(added, { kind: 'master', id: 'discogs-master:501', added: true, artistIds: ['discogs-artist:77'], tracks: 4 });
      assert.deepEqual(await likeState(), unliked, 'adding likes nothing');
      const requestsAfterAdd = fake.requests.length;
      assert.deepEqual(await server.ok('/api/discogs/add', { kind: 'master', id: 501 }), { kind: 'master', id: 'discogs-master:501', added: false });
      assert.equal(fake.requests.length, requestsAfterAdd, 'a repeat add is answered without Discogs');
      assert.deepEqual(await likeState(), unliked, 'a repeat add likes nothing');
      // A pressing of the same album, and the artist, are already held.
      assert.equal((await server.ok('/api/discogs/add', { kind: 'release', id: 9001 })).added, false);
      assert.deepEqual(await server.ok('/api/discogs/add', { kind: 'artist', id: 77 }), { kind: 'artist', id: 'discogs-artist:77', added: false });

      // The album and artist are in Library and local search now.
      const albums = await server.ok('/api/albums') as unknown as { id: string }[];
      assert.equal(albums.filter(a => a.id === 'discogs-master:501').length, 1);
      assert(albums.some(a => a.id === 'sp-local'));
      const artists = await server.ok('/api/artists') as unknown as { id: string; name: string }[];
      assert.deepEqual(artists.filter(a => a.id.startsWith('discogs-')).map(a => a.name), ['The Quiet Ferns']);
      const after = await server.ok('/api/search?q=Quiet%20Ferns');
      assert.deepEqual(after.artists.map((a: any) => a.id), ['discogs-artist:77']);
      assert.deepEqual(after.albums.map((a: any) => a.id), ['discogs-master:501']);
      assert.equal(after.songs.length, 4);
      const page = await server.ok('/api/album?id=discogs-master:501');
      assert.equal(page.album.label, 'Fern Records');
      assert.equal(page.album.release_date, '2019-04-12');
      assert.deepEqual(page.artists, [{ id: 'discogs-artist:77', name: 'The Quiet Ferns' }]);
      assert.equal(page.tracks.length, 4);
      const artistPage = await server.ok('/api/artist?id=discogs-artist:77');
      assert.deepEqual(artistPage.albums.map((a: any) => a.id), ['discogs-master:501']);

      // Search now says what is held.
      const again = await server.ok('/api/discogs/search?q=Quiet%20Ferns');
      assert.equal(again.artists[0].library, 'discogs-artist:77');
      assert.deepEqual(again.albums.map((a: any) => a.library), ['discogs-master:501', null, null]);

      // A cassette release with no master, vinyl-style positions and a year-only date.
      const demo = await server.ok('/api/discogs/add', { kind: 'release', id: 9002 });
      assert.equal(demo.id, 'discogs-release:9002');
      const demoPage = await server.ok('/api/album?id=discogs-release:9002');
      assert.deepEqual([demoPage.album.album_type, demoPage.album.release_date], ['ep', '2017']);

      // Adding is metadata only: nothing was queued for download or liked,
      // and the CD of the same album is still waiting to be ripped.
      assert.deepEqual((await server.ok('/api/upgrades')).jobs, []);
      const cds = await server.ok('/api/cds');
      assert.deepEqual(cds.items.map((item: any) => [item.title, item.status]), [['Hollow Lanterns', 'shelf']]);

      // An artist added on their own stays in Library after another band's
      // album credits them on one track; a guest only credited on a track
      // never joins it.
      const libraryArtists = async () => (await server.ok('/api/artists') as unknown as { id: string; name: string }[])
        .filter(a => a.id.startsWith('discogs-')).map(a => a.name).sort();
      assert.deepEqual(await server.ok('/api/discogs/add', { kind: 'artist', id: 91 }), { kind: 'artist', id: 'discogs-artist:91', added: true });
      assert.deepEqual(await libraryArtists(), ['Mara Quill', 'The Quiet Ferns']);
      const borrowed = await server.ok('/api/discogs/add', { kind: 'master', id: 601 });
      assert.deepEqual([borrowed.added, borrowed.artistIds], [true, ['discogs-artist:88']]);
      assert.deepEqual(await libraryArtists(), ['Mara Quill', 'Night Lanterns', 'The Quiet Ferns']);
      const credits = (await server.ok('/api/album?id=discogs-master:601')).tracks.map((t: any) => t.artists);
      assert.deepEqual(credits, ['Night Lanterns', 'Mara Quill', 'Session Horn']);
      // The guest has a row, but Library does not list them, so Discogs
      // results must not call them held: both endpoints offer to add them.
      const guestStatus = async () => [
        (await server.ok('/api/discogs/search?q=Session%20Horn')).artists[0].library,
        (await server.ok('/api/discogs/artist?id=92')).artist.library,
      ];
      assert.deepEqual(await guestStatus(), [null, null]);
      // Putting the guest in the library on purpose needs no Discogs call: the row exists.
      const requestsBeforeGuest = fake.requests.length;
      assert.deepEqual(await server.ok('/api/discogs/add', { kind: 'artist', id: 92 }), { kind: 'artist', id: 'discogs-artist:92', added: true });
      assert.equal(fake.requests.length, requestsBeforeGuest);
      assert.deepEqual(await libraryArtists(), ['Mara Quill', 'Night Lanterns', 'Session Horn', 'The Quiet Ferns']);
      assert.deepEqual(await guestStatus(), ['discogs-artist:92', 'discogs-artist:92']);

      // A discography longer than the pages read is reported as cut short,
      // even when the pages read held no albums of the artist's own.
      const capped = await server.ok('/api/discogs/artist?id=91');
      assert.deepEqual([capped.albums, capped.truncated], [[], true]);
      assert.equal((await server.ok('/api/discogs/artist?id=77')).truncated, false);
      // A new artist's page resolves at once (the name cache is rebuilt after an add).
      assert.equal((await server.ok('/api/artist?id=discogs-artist:91')).artist.name, 'Mara Quill');

      // Un-liking a Discogs add here keeps it in the library, unliked.
      await server.ok('/api/likes', { id: 'discogs-master:501', kind: 'album', liked: false });
      const afterUnlike = (await server.ok('/api/albums') as unknown as { id: string; liked: number }[])
        .filter(a => a.id === 'discogs-master:501');
      assert.deepEqual(afterUnlike.map(a => a.liked), [0]);

      // Discogs pushing back, and bad requests.
      const limited = await server.call('/api/discogs/search?q=ratelimit');
      assert.equal(limited.status, 429);
      assert.match(limited.body.error, /rate limit reached\. Try again in 7 seconds/);
      const outage = await server.call('/api/discogs/search?q=outage');
      assert.deepEqual([outage.status, outage.body.error], [502, 'Discogs is unavailable right now']);
      assert.equal((await server.call('/api/discogs/add', { kind: 'single', id: 1 })).status, 400);
      assert.equal((await server.call('/api/discogs/add', { kind: 'master', id: -4 })).status, 400);
      assert.equal((await server.call('/api/discogs/album?kind=master&id=999')).status, 404);
      // Local search keeps working while Discogs is down.
      assert.equal((await server.ok('/api/search?q=Local')).albums[0].id, 'sp-local');
      assert(!server.log().includes(TOKEN), 'the token never reaches the log');
    } finally {
      await server.stop();
    }

    const unconfigured = await startServer(dir, { DISCOGS_API_URL: fake.url });
    try {
      const before = fake.requests.length;
      const refused = await unconfigured.call('/api/discogs/search?q=Quiet%20Ferns');
      assert.deepEqual([refused.status, refused.body.error], [503, 'Discogs is not configured on this server']);
      assert.equal((await unconfigured.call('/api/discogs/add', { kind: 'master', id: 502 })).status, 503);
      assert.equal(fake.requests.length, before);
      // What was added earlier is still in the library without Discogs.
      assert.equal((await unconfigured.ok('/api/search?q=Hollow')).albums[0].id, 'discogs-master:501');
    } finally {
      await unconfigured.stop();
    }
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
