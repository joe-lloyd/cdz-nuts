import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { TasteDb } from './db.ts';

const SERVER = path.join(import.meta.dirname, 'server.ts');

/** Write an audio file that landed `hoursAgo`, so the walk has real mtimes to order by. */
function landed(file: string, hoursAgo: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
  const at = new Date(Date.now() - hoursAgo * 3_600_000);
  utimesSync(file, at, at);
}

test('HTTP: /api/latest lists what landed on disk, newest first, from all three layouts', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'music-latest-'));
  const music = path.join(dir, 'music');
  const dbFile = path.join(dir, 'taste.db');
  new TasteDb(dbFile).db.close();

  // A Lidarr album dates from its newest track, not the cover written later.
  landed(path.join(music, 'Porcupine Tree', 'In Absentia (2002) [Album]', '01 Blackest Eyes.flac'), 30);
  landed(path.join(music, 'Porcupine Tree', 'In Absentia (2002) [Album]', '02 Trains.flac'), 3);
  landed(path.join(music, 'Porcupine Tree', 'In Absentia (2002) [Album]', 'cover.jpg'), 0);
  landed(path.join(music, '_YouTube', 'Igorrr', 'Spirituality and Distortion', '01 Downgrade Desert.mp3'), 1);
  landed(path.join(music, '_Singles', 'Harmony Korine', 'The 78.opus'), 2);
  landed(path.join(music, '_Singles', 'Harmony Korine', 'notes.txt'), 0);

  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', SERVER], {
    env: { ...process.env, PORT: String(port), SPOTIFY_DB: dbFile, APP_LIBRARY_PREFIX: music,
      PLAYLISTS_DB: path.join(dir, 'playlists.db'), UPGRADES_DB: path.join(dir, 'upgrades.db'), LIKES_DB: path.join(dir, 'likes.db'),
      APP_PLAYS_DB: path.join(dir, 'plays.db'), PROVENANCE_DB: path.join(dir, 'provenance.db'), DISCOGS_DB: path.join(dir, 'discogs.db'),
      LYRICS_DB: path.join(dir, 'lyrics.db'), JELLYFIN_URL: '', JELLYFIN_API_KEY: '', MUSIC_SOURCE_HOST: '', LISTENBRAINZ_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    for (let i = 0; i < 100 && !output.includes('taste-db ui on'); i++) {
      if (child.exitCode !== null) assert.fail(output);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.match(output, /taste-db ui on/);

    // Two requests at once both get the full list, shared walk or not.
    // This pins what the walk returns. That the walk no longer blocks the
    // server is a timing property, checked against the deployed one.
    const [first, second] = await Promise.all([1, 2].map(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/latest`);
      assert.equal(response.status, 200);
      return await response.json() as { name: string; artists: string; kind: string; added_at: string }[];
    }));
    assert.deepEqual(second, first);
    assert.deepEqual(first.map(({ name, artists, kind }) => ({ name, artists, kind })), [
      { name: 'Spirituality and Distortion', artists: 'Igorrr', kind: 'imported' },
      { name: 'The 78', artists: 'Harmony Korine', kind: 'single' },
      { name: 'In Absentia (2002) [Album]', artists: 'Porcupine Tree', kind: 'download' },
    ]);
    const hoursAgo = (iso: string) => Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
    assert.deepEqual(first.map(row => hoursAgo(row.added_at)), [1, 2, 3]);
  } finally {
    // A server that died at startup has already exited; waiting for that
    // again would hang the test until its timeout and hide the output.
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});
