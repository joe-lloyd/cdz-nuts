// The MCP taste_query tool in the HomeLab repo answers from these routes, and its
// answers must equal the ones it used to read straight out of spotify.db. So these
// tests pin the three things the older routes did not carry: the first credited
// artist as one name, the whole-database counts, and the artist name search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { TasteDb } from './db.ts';
import { PlaysStore } from './plays.ts';

const SERVER = path.join(import.meta.dirname, 'server.ts');

test('HTTP: the taste routes carry the first artist, the full counts and the name search', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'music-taste-routes-'));
  const dbFile = path.join(dir, 'taste.db');
  const db = new TasteDb(dbFile);
  const artists: [string, string, string | null, number | null, number | null, number][] = [
    ['elp', 'Emerson, Lake & Palmer', '["progressive rock"]', 61, 900, 1],
    ['keith', 'Keith Emerson', null, 40, 50, 0],
    ['greg', 'Greg Lake', '["prog"]', 50, 80, 0],
    ['pt', 'Porcupine Tree', '["art rock","neo-prog"]', 70, 2000, 1],
    ['ptc', 'Porcupine Tree Cover Band', null, null, null, 0],
    ['under', 'Under_score', null, 10, 1, 0],
    ['other', 'Other', null, 5, 1, 0],
  ];
  for (const [id, name, genres, popularity, followers, followed] of artists) {
    db.run('INSERT INTO artists (id, name, genres, popularity, followers, is_followed) VALUES (?, ?, ?, ?, ?, ?)', id, name, genres, popularity, followers, followed);
  }
  db.run("INSERT INTO albums (id, name) VALUES ('album', 'Album')");
  // Credits listed out of order on purpose: position decides, not insertion order.
  const tracks: [string, string, [string, number][]][] = [
    ['t-elp', 'Karn Evil 9', [['greg', 1], ['keith', 0]]],
    ['t-pt', 'Even Less', [['pt', 0]]],
    ['t-feat', 'Featured', [['other', 0], ['pt', 1]]],
    ['t-orphan', 'No credit', []],
  ];
  for (const [id, name, credits] of tracks) {
    db.run("INSERT INTO tracks (id, name, album_id) VALUES (?, ?, 'album')", id, name);
    for (const [artist, position] of credits) db.run('INSERT INTO track_artists VALUES (?, ?, ?)', id, artist, position);
  }
  for (const [id, removed] of [['t-pt', null], ['t-feat', null], ['t-elp', '2026-01-01']]) {
    db.run('INSERT INTO liked_tracks (track_id, added_at, removed_at) VALUES (?, ?, ?)', id, '2025-01-01', removed);
  }
  db.run("INSERT INTO top_artists VALUES ('medium_term', 1, 'pt'), ('medium_term', 2, 'elp')");
  db.run("INSERT INTO top_tracks VALUES ('medium_term', 1, 't-elp'), ('medium_term', 2, 't-orphan')");
  db.run("INSERT INTO plays (played_at, track_id) VALUES ('2026-10-01T10:00:00.000Z', 't-elp'), ('2026-10-03T10:00:00.000Z', 't-pt')");
  db.db.close();
  // A play made in this player, newer than both of Spotify's.
  const appPlays = new PlaysStore(path.join(dir, 'plays.db'));
  appPlays.record('t-feat', 1000, true);
  appPlays.close();

  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', SERVER], {
    env: { ...process.env, PORT: String(port), SPOTIFY_DB: dbFile,
      PLAYLISTS_DB: path.join(dir, 'playlists.db'), UPGRADES_DB: path.join(dir, 'upgrades.db'), LIKES_DB: path.join(dir, 'likes.db'),
      APP_PLAYS_DB: path.join(dir, 'plays.db'), PROVENANCE_DB: path.join(dir, 'provenance.db'), DISCOGS_DB: path.join(dir, 'discogs.db'),
      LYRICS_DB: path.join(dir, 'lyrics.db'), JELLYFIN_URL: '', JELLYFIN_API_KEY: '', MUSIC_SOURCE_HOST: '', LISTENBRAINZ_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const get = async (route: string) => {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, output);
    return await response.json();
  };
  try {
    for (let i = 0; i < 100; i++) {
      if (output.includes('taste-db ui on')) break;
      if (child.exitCode !== null) assert.fail(output);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.match(output, /taste-db ui on/);

    // top-tracks: the first credit by position, null when a track has none,
    // and `artists` is still the joined string it always was.
    const top = await get('/api/top-tracks?range=medium_term') as { rank: number; name: string; artist: string | null; artists: string | null }[];
    assert.deepEqual(top.map(({ rank, name, artist, artists }) => ({ rank, name, artist, artists })), [
      { rank: 1, name: 'Karn Evil 9', artist: 'Keith Emerson', artists: 'Keith Emerson, Greg Lake' },
      { rank: 2, name: 'No credit', artist: null, artists: null },
    ]);

    // plays: both sources carry it, newest first.
    const plays = await get('/api/plays') as { source: string; name: string; artist: string | null; artists: string }[];
    assert.deepEqual(plays.map(({ source, name, artist, artists }) => ({ source, name, artist, artists })), [
      { source: 'app', name: 'Featured', artist: 'Other', artists: 'Other, Porcupine Tree' },
      { source: 'spotify', name: 'Even Less', artist: 'Porcupine Tree', artists: 'Porcupine Tree' },
      { source: 'spotify', name: 'Karn Evil 9', artist: 'Keith Emerson', artists: 'Keith Emerson, Greg Lake' },
    ]);

    // top-artists gains popularity and keeps what it had.
    const ranking = await get('/api/top-artists?range=medium_term') as Record<string, unknown>[];
    assert.deepEqual(ranking.map(({ rank, name, popularity, genres }) => ({ rank, name, popularity, genres })), [
      { rank: 1, name: 'Porcupine Tree', popularity: 70, genres: '["art rock","neo-prog"]' },
      { rank: 2, name: 'Emerson, Lake & Palmer', popularity: 61, genres: '["progressive rock"]' },
    ]);
    assert.ok('image_url' in ranking[0] && 'is_followed' in ranking[0] && 'id' in ranking[0]);

    // stats: `artists` is still the taste (followed or liked), `all_*` count every row.
    const stats = await get('/api/stats') as { counts: Record<string, number> };
    assert.equal(stats.counts.all_artists, 7);
    assert.equal(stats.counts.all_tracks, 4);
    assert.equal(stats.counts.artists, 3, 'followed ELP and Porcupine Tree, plus Other through a liked track');
    assert.equal(stats.counts.liked, 2);
    assert.equal(stats.counts.followed, 2);
    assert.equal(stats.counts.plays, 2);

    // artist-search: contains-match, most popular first, NULL popularity last,
    // liked tracks counted without the un-liked ones.
    const found = await get('/api/artist-search?name=porcupine') as Record<string, unknown>[];
    assert.deepEqual(found, [
      { name: 'Porcupine Tree', genres: '["art rock","neo-prog"]', popularity: 70, followers: 2000, is_followed: 1, liked_tracks: 2 },
      { name: 'Porcupine Tree Cover Band', genres: null, popularity: null, followers: null, is_followed: 0, liked_tracks: 0 },
    ]);
    assert.deepEqual((await get('/api/artist-search?name=emerson') as { name: string; liked_tracks: number }[]).map(({ name, liked_tracks }) => ({ name, liked_tracks })), [
      { name: 'Emerson, Lake & Palmer', liked_tracks: 0 },
      { name: 'Keith Emerson', liked_tracks: 0 },
    ]);
    assert.equal((await get('/api/artist-search?name=porcupine&limit=1') as unknown[]).length, 1);
    // The pattern is not escaped, as in the tool: `_` matches any one character.
    assert.deepEqual((await get('/api/artist-search?name=under_') as { name: string }[]).map(row => row.name), ['Under_score']);
    assert.deepEqual((await get('/api/artist-search?name=porcupin_%20tree') as { name: string }[]).map(row => row.name), ['Porcupine Tree', 'Porcupine Tree Cover Band']);
    assert.deepEqual(await get('/api/artist-search?name=nobody-by-this-name'), []);
    assert.deepEqual(await get('/api/artist-search'), []);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});
