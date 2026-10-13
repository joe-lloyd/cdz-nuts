// A fictional home music world, written in the real layout, for tests that need
// every route to have something to say: the eight databases, a library folder
// with covers and sidecars, an images folder, and the list of items a fake
// Jellyfin should serve for the library files. Deterministic: the same call
// writes the same bytes, so two servers started on two copies can be compared.
//
//   node --disable-warning=ExperimentalWarning scripts/fake-data.ts <out dir>
//
// writes <out>/data/*.db, <out>/data/images/**, <out>/library/** and
// <out>/jellyfin-items.json. Nothing here is real data.
import '../src/sql-node-host.ts';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AlbumGroupStore } from '../src/album-groups.ts';
import { TasteDb } from '../src/db.ts';
import { ShelfStore } from '../src/discogs.ts';
import { FileIdentityStore } from '../src/file-identity.ts';
import { LikesStore } from '../src/likes.ts';
import { ListenBrainz } from '../src/listenbrainz.ts';
import { LyricsService } from '../src/lyrics.ts';
import { PlaylistStore } from '../src/playlists.ts';
import { PlaysStore } from '../src/plays.ts';
import { ProvenanceStore } from '../src/provenance.ts';
import { nodeSql } from '../src/sql-node.ts';
import { UpgradeStore } from '../src/upgrades.ts';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/fake-data.ts <out dir>');
  process.exit(2);
}
rmSync(out, { recursive: true, force: true });
const data = path.join(out, 'data');
const library = path.join(out, 'library');
mkdirSync(data, { recursive: true });
mkdirSync(library, { recursive: true });

// One clock for everything: the world is "now" = 2026-10-12T12:00:00Z.
const NOW = Date.parse('2026-10-12T12:00:00Z');
const daysAgo = (n: number, hour = 12) => new Date(NOW - n * 86_400_000 + (hour - 12) * 3_600_000).toISOString();
const at = (rel: string) => path.join(library, rel);
const sleeve = (label: string) => new TextEncoder().encode(`JPEG-FAKE:${label}`);
function put(file: string, bytes: Uint8Array | string, ageDays?: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  if (ageDays !== undefined) {
    const when = (NOW - ageDays * 86_400_000) / 1000;
    utimesSync(file, when, when);
  }
}

// --- Spotify side: spotify.db ------------------------------------------------
const taste = new TasteDb(path.join(data, 'spotify.db'));
const names = ['Local Signals', 'Mira Vale', 'Glass Harbour', 'Low Orbit Club', 'Soft Focus', 'Hana North',
  'Porcupine Tree', 'Igorrr', 'Yppah', 'Nosaj Thing', 'Emerson, Lake & Palmer', 'Various Artists'];
const artists = names.map((name, i) => ({
  id: `ar${String(i + 1).padStart(2, '0')}`, name,
  genres: i % 3 === 0 ? ['indietronica', 'dream pop'] : i % 3 === 1 ? ['post-rock', 'shoegaze'] : ['art pop', 'nu jazz'],
  popularity: 40 + i * 4, followers: { total: 10_000 + i * 7_777 }, images: [{ url: `https://img.example/${i}.jpg` }],
}));
artists.forEach((artist, i) => {
  taste.upsertArtist(artist, { followed: i % 4 !== 3 });
  taste.run('UPDATE artists SET discog_synced_at = ? WHERE id = ?', daysAgo(2), artist.id);
  taste.run('INSERT INTO artist_mbid (artist_id, mbid, method, resolved_at) VALUES (?, ?, ?, ?)', artist.id,
    i === 11 ? '' : `00000000-0000-4000-8000-0000000000${String(i + 1).padStart(2, '0')}`, 'name', daysAgo(30));
});
taste.run("UPDATE artists SET unfollowed_at = ?, is_followed = 0 WHERE id = 'ar08'", daysAgo(9));
taste.run("UPDATE artists SET removed_at = ? WHERE id = 'ar10'", daysAgo(20));

type Album = { id: string; name: string; artist: string; type: string; release: string; saved: boolean; tracks: string[]; label: string };
const albums: Album[] = [];
const titles = ['Night Drive', 'Afterimage', 'Weather Systems', 'Rooms Without Clocks', 'Velvet Static', 'Small Constellations',
  'In Absentia', 'Spirituality and Distortion', 'The Yppah Sessions', 'Drift', 'Brain Salad Surgery', 'Compilation One',
  'Night Drive (Deluxe)', 'Afterimage (Remastered 2020)', 'Sleeve Notes', 'Late Arrivals', 'Quiet Machines', 'Tidewater',
  'Ghost Frequency', 'Harbour Lights', 'Parallel Rooms', 'Single Bell', 'Nocturne', 'Last Light'];
titles.forEach((name, i) => {
  const artist = artists[i % 11 === 10 ? 10 : i % 10].id;
  const type = name === 'Compilation One' ? 'compilation' : ['Single Bell', 'Nocturne', 'Last Light'].includes(name) ? 'single' : 'album';
  const count = type === 'single' ? 2 : 4 + (i % 4);
  albums.push({
    id: `al${String(i + 1).padStart(2, '0')}`, name, artist: type === 'compilation' ? 'ar12' : artist, type,
    release: `${2018 + (i % 9)}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
    saved: i % 3 !== 2, label: `Label ${i % 5}`,
    tracks: Array.from({ length: count }, (_, t) => `${name.replace(/ \(.*\)/, '')} Part ${t + 1}`),
  });
});
// A release in the next month and one last week, for /api/releases.
albums.push({ id: 'al25', name: 'Coming Soon', artist: 'ar01', type: 'album', release: '2026-10-30', saved: false, label: 'Label 1', tracks: ['Coming Soon Part 1'] });
albums.push({ id: 'al26', name: 'Fresh Out', artist: 'ar02', type: 'album', release: '2026-10-07', saved: true, label: 'Label 2', tracks: ['Fresh Out Part 1', 'Fresh Out Part 2'] });

const trackIds: string[] = [];
let liked = 0;
for (const album of albums) {
  const artist = artists.find((a) => a.id === album.artist)!;
  taste.upsertAlbum({
    id: album.id, name: album.name, album_type: album.type, release_date: album.release, release_date_precision: 'day',
    total_tracks: album.tracks.length, label: album.label, popularity: 40 + album.tracks.length,
    artists: [artist], images: [{ url: `https://img.example/${album.id}.jpg` }],
  }, album.saved ? { savedAt: daysAgo(40 + Number(album.id.slice(2))) } : {});
  taste.run('UPDATE albums SET tracks_synced = 1 WHERE id = ?', album.id);
  taste.run('INSERT OR REPLACE INTO artist_albums (artist_id, album_id, album_group) VALUES (?, ?, ?)', album.artist, album.id, album.type);
  album.tracks.forEach((name, t) => {
    const id = `${album.id}t${t + 1}`;
    trackIds.push(id);
    taste.upsertTrack({
      id, name, album: { id: album.id, name: album.name }, artists: t === 1 ? [artist, artists[(Number(album.id.slice(2)) + 3) % 10]] : [artist],
      disc_number: 1, track_number: t + 1, duration_ms: 180_000 + t * 17_000 + Number(album.id.slice(2)) * 1_300, explicit: t === 2, popularity: 30 + t,
    });
    if ((t + Number(album.id.slice(2))) % 3 !== 0) {
      taste.run('INSERT OR REPLACE INTO liked_tracks (track_id, added_at, removed_at) VALUES (?, ?, ?)', id, daysAgo(liked % 90 + 1, 9 + (liked % 12)), liked % 11 === 0 ? daysAgo(2) : null);
      liked += 1;
    }
  });
}
// Editions the grouping module would have judged.
const groups = new AlbumGroupStore(path.join(data, 'spotify.db'));
groups.replaceMembers(['al01', 'al13'], [
  { album_id: 'al01', group_id: 'al01', relation: 'canonical', source: 'exact', p: null },
  { album_id: 'al13', group_id: 'al01', relation: 'edition', source: 'marker', p: 0.97 },
]);
groups.replaceMembers(['al02', 'al14'], [
  { album_id: 'al02', group_id: 'al02', relation: 'canonical', source: 'exact', p: null },
  { album_id: 'al14', group_id: 'al02', relation: 'same_release', source: 'typesafe', p: 0.88 },
]);
groups.close();

taste.run("INSERT INTO playlists (id, name, description, owner_id, owner_name, is_public, total_tracks, snapshot_id) VALUES ('pl01', 'Night bus', 'Songs for the last ride home', 'joe', 'Joe', 1, 8, 'snap1')");
taste.run("INSERT INTO playlists (id, name, description, owner_name, total_tracks, removed_at) VALUES ('pl02', 'Old mix', '', 'Joe', 3, ?)", daysAgo(5));
trackIds.slice(0, 8).forEach((id, i) => taste.run('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at, added_by) VALUES (?, ?, ?, ?, ?)', 'pl01', id, i + 1, daysAgo(60 - i), 'joe'));
trackIds.slice(8, 11).forEach((id, i) => taste.run('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at, removed_at) VALUES (?, ?, ?, ?, ?)', 'pl02', id, i + 1, daysAgo(80), i === 2 ? daysAgo(3) : null));
['short_term', 'medium_term', 'long_term'].forEach((range, r) => {
  artists.slice(0, 6).forEach((a, i) => taste.run('INSERT INTO top_artists (time_range, rank, artist_id) VALUES (?, ?, ?)', range, i + 1, artists[(i + r) % 6].id));
  trackIds.slice(0, 6).forEach((id, i) => taste.run('INSERT INTO top_tracks (time_range, rank, track_id) VALUES (?, ?, ?)', range, i + 1, trackIds[(i * 3 + r) % trackIds.length]));
});
// Recently played across 40 days, at varied hours so the histograms have a shape,
// including hours either side of midnight in Amsterdam.
for (let i = 0; i < 160; i += 1) {
  const day = i % 40;
  const hour = [0, 1, 7, 8, 12, 18, 19, 21, 22, 23][i % 10];
  taste.run('INSERT OR IGNORE INTO plays (played_at, track_id, context_type, context_uri) VALUES (?, ?, ?, ?)',
    new Date(NOW - day * 86_400_000 - (12 - hour) * 3_600_000 - (i % 7) * 60_000).toISOString(), trackIds[(i * 7) % trackIds.length], i % 3 ? 'playlist' : 'album', null);
}
for (let i = 0; i < 400; i += 1) {
  const track = trackIds[(i * 5) % trackIds.length];
  const album = albums.find((a) => track.startsWith(a.id + 't'))!;
  taste.run(`INSERT OR IGNORE INTO history_plays (ts, track_name, ms_played, track_id, artist_name, album_name, platform, country, skipped)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  new Date(Date.parse('2025-01-01T00:00:00Z') + i * 21 * 3_600_000).toISOString(), `${album.name} ${track}`, i % 9 === 0 ? 12_000 : 150_000 + i * 300, track,
  artists.find((a) => a.id === album.artist)!.name, album.name, 'android', 'NL', i % 9 === 0 ? 1 : 0);
}
taste.run("INSERT INTO events (id, artist_id, name, datetime, venue, city, country, url, first_seen_at, last_seen_at) VALUES ('ev01', 'ar02', 'Mira Vale at Paradiso', '2026-12-14T19:30:00Z', 'Paradiso', 'Amsterdam', 'NL', 'https://tickets.example/1', ?, ?)", daysAgo(10), daysAgo(1));
taste.run("INSERT INTO events (id, artist_id, name, datetime, venue, city, country, url, first_seen_at, last_seen_at) VALUES ('ev02', 'ar03', 'Glass Harbour in Berlin', '2027-02-01T20:00:00Z', 'Astra', 'Berlin', 'DE', 'https://tickets.example/2', ?, ?)", daysAgo(10), daysAgo(1));
taste.run("INSERT INTO events (id, artist_id, name, datetime, venue, city, country, url, first_seen_at, last_seen_at) VALUES ('ev03', 'ar01', 'Local Signals in Austin', '2027-03-01T20:00:00Z', 'Emos', 'Austin', 'US', 'https://tickets.example/3', ?, ?)", daysAgo(10), daysAgo(1));
taste.run('INSERT INTO sync_runs (started_at, finished_at, summary) VALUES (?, ?, ?)', daysAgo(1, 4), daysAgo(1, 5), JSON.stringify({ liked_tracks: liked, total_tracks: trackIds.length }));

// --- the library on disk, the Lidarr tables, and provenance ---------------------
const lib: { rel: string; artist: string; title: string; album: string; codec: string; track: number; ms: number; source: string; age: number }[] = [];
for (const album of albums.slice(0, 12)) {
  const artist = artists.find((a) => a.id === album.artist)!.name;
  const folder = `${artist}/${album.name} (${album.release.slice(0, 4)}) [${album.type === 'single' ? 'Single' : 'Album'}]`;
  album.tracks.forEach((title, t) => {
    const codec = (t + Number(album.id.slice(2))) % 4 === 0 ? 'flac' : 'mp3';
    lib.push({ rel: `${folder}/${String(t + 1).padStart(2, '0')} ${title}.${codec}`, artist, title, album: album.name, codec, track: t + 1, ms: 180_000 + t * 17_000 + Number(album.id.slice(2)) * 1_300, source: 'soulseek', age: 3 + Number(album.id.slice(2)) * 2 + t });
  });
  put(at(`${folder}/cover.jpg`), sleeve(album.id), 3 + Number(album.id.slice(2)) * 2);
}
// Singles and YouTube imports, each with the layout the intake writes.
for (const [i, title] of ['Radio Edit One', 'Radio Edit Two', 'Nameless Loop'].entries()) {
  const rel = `_Singles/Yppah/${title}.opus`;
  lib.push({ rel, artist: 'Yppah', title, album: 'Singles', codec: 'opus', track: 0, ms: 200_000 + i * 1_000, source: 'youtube', age: 1 + i });
  if (i < 2) put(at(`_Singles/Yppah/${title}.jpg`), sleeve(`single-${i}`), 1 + i);
}
lib.push({ rel: '_YouTube/Igorrr/Spirituality and Distortion/01 Downgrade Desert.mp3', artist: 'Igorrr', title: 'Downgrade Desert', album: 'Spirituality and Distortion', codec: 'mp3', track: 1, ms: 240_000, source: 'youtube', age: 0.5 });
put(at('_YouTube/Igorrr/Spirituality and Distortion/cover.jpg'), sleeve('yt'), 0.5);
for (const file of lib) put(at(file.rel), `audio:${file.rel}`, file.age);

const provenance = new ProvenanceStore(path.join(data, 'provenance.db'));
provenance.upsert(lib.map((file) => ({
  path: `/data/library/music/${file.rel}`, artist: file.artist, title: file.title, album: file.album, source: file.source,
  detail: file.source === 'youtube' ? 'yt-dlp' : 'slskd', codec: file.codec, bitrate: file.codec === 'flac' ? 900_000 : 320_000,
  sample_rate: 44_100, bit_depth: file.codec === 'flac' ? 16 : null, size_bytes: 1_000_000 + file.ms, mtime: Math.round((NOW - file.age * 86_400_000) / 1000),
  duration_ms: file.ms, track_number: file.track || null, disc_number: 1,
})));
provenance.close();
const identity = new FileIdentityStore(path.join(data, 'provenance.db'));
identity.close();

taste.db.exec(`
  CREATE TABLE IF NOT EXISTS lidarr_library (mbid TEXT PRIMARY KEY, artist_name TEXT, album_count INTEGER, track_files INTEGER, total_tracks INTEGER, size_on_disk INTEGER, synced_at TEXT);
  CREATE TABLE IF NOT EXISTS lidarr_album (foreign_album_id TEXT, mbid TEXT, title TEXT, year INTEGER, norm_title TEXT, track_files INTEGER);
  CREATE TABLE IF NOT EXISTS album_download_status (album_id TEXT PRIMARY KEY, downloaded INTEGER, lidarr_title TEXT, match_score REAL, synced_at TEXT);
  CREATE TABLE IF NOT EXISTS lidarr_sync (id INTEGER PRIMARY KEY CHECK (id = 1), synced_at TEXT, downloaded_album_count INTEGER, artists_in_lidarr INTEGER, artists_matched INTEGER, tastedb_albums_checked INTEGER, tastedb_albums_downloaded INTEGER, releases_tracked INTEGER, recordings_mapped INTEGER);
  CREATE TABLE IF NOT EXISTS lidarr_release (foreign_album_id TEXT PRIMARY KEY, artist_mbid TEXT, artist_name TEXT, title TEXT, album_type TEXT, release_date TEXT, cover_url TEXT, track_files INTEGER, total_tracks INTEGER, monitored INTEGER, folder TEXT, synced_at TEXT);
  CREATE TABLE IF NOT EXISTS lidarr_recording (recording_mbid TEXT, path TEXT, artist_mbid TEXT, artist_name TEXT, title TEXT, album_title TEXT, duration_ms INTEGER, PRIMARY KEY (recording_mbid, path));
`);
albums.slice(0, 12).forEach((album, i) => {
  taste.run('INSERT OR REPLACE INTO album_download_status VALUES (?, ?, ?, ?, ?)', album.id, 1, album.name, 1, daysAgo(0, 8));
  taste.run('INSERT INTO lidarr_album VALUES (?, ?, ?, ?, ?, ?)', `fa${i}`, `00000000-0000-4000-8000-0000000000${String(i % 10 + 1).padStart(2, '0')}`, album.name, Number(album.release.slice(0, 4)), album.name.toLowerCase(), album.tracks.length);
});
taste.run('INSERT INTO lidarr_sync VALUES (1, ?, 12, 40, 10, 24, 12, 2, ?)', daysAgo(0, 8), lib.length);
taste.run("INSERT INTO lidarr_release VALUES ('rel1', '00000000-0000-4000-8000-000000000001', 'Local Signals', 'Coming Soon', 'Album', '2026-10-30', 'https://img.example/cs.jpg', 0, 9, 1, NULL, ?)", daysAgo(0, 8));
taste.run("INSERT INTO lidarr_release VALUES ('rel2', '00000000-0000-4000-8000-000000000002', 'Mira Vale', 'Fresh Out', 'Album', '2026-10-07', 'https://img.example/fo.jpg', 2, 2, 1, 'Mira Vale/Fresh Out (2026) [Album]', ?)", daysAgo(0, 8));
lib.slice(0, 20).forEach((file, i) => taste.run('INSERT OR REPLACE INTO lidarr_recording VALUES (?, ?, ?, ?, ?, ?, ?)',
  `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `/data/library/music/${file.rel}`, `00000000-0000-4000-8000-0000000000${String(i % 10 + 1).padStart(2, '0')}`, file.artist, file.title, file.album, file.ms));
taste.db.close();

// --- the other small databases ---------------------------------------------------
const plays = new PlaysStore(path.join(data, 'app-plays.db'));
for (let i = 0; i < 25; i += 1) plays.record(trackIds[(i * 3) % trackIds.length], 60_000 + i * 4_000, i % 2 === 0);
plays.close();
const playsDb = nodeSql.open(path.join(data, 'app-plays.db'));
playsDb.prepare("UPDATE app_plays SET played_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || (id % 20) || ' days', '-' || (id % 5) || ' hours')").run('2026-10-12T12:00:00Z');
playsDb.close();

const likes = new LikesStore(path.join(data, 'likes.db'));
likes.set('al01t1', true);
likes.set('al02t2', false);
likes.set('al03', true, 'album');
likes.set('ar01', true, 'artist');
likes.db.prepare('UPDATE app_likes SET added_at = ?').run(daysAgo(4));
likes.db.prepare('UPDATE app_entity_likes SET added_at = ?').run(daysAgo(4));
likes.db.close();

const playlists = new PlaylistStore(path.join(data, 'playlists.db'));
playlists.db.close();

const upgrades = new UpgradeStore(path.join(data, 'upgrades.db'), () => NOW);
const mp3 = lib.find((f) => f.codec === 'mp3')!;
upgrades.create({ trackId: 'al01t1', artist: mp3.artist, title: mp3.title, album: mp3.album, currentPath: `/data/library/music/${mp3.rel}`, currentCodec: 'mp3', durationMs: mp3.ms });
upgrades.create({ sourceUrl: 'https://youtu.be/abc123', artist: 'Igorrr', title: 'Downgrade Desert', album: 'Spirituality and Distortion' });
upgrades.create({ sourceUrl: 'https://open.spotify.com/track/xyz', artist: 'Glass Harbour', title: 'Pressure Drop' });
const local = lib.find((f) => f.rel.startsWith('_YouTube'))!;
upgrades.create({ sourceUrl: 'https://youtu.be/zzz', artist: local.artist, title: local.title, album: local.album, currentPath: `/data/library/music/${local.rel}`, currentCodec: 'mp3', autoUpgrade: false });
upgrades.rememberArtistMbid('Igorrr', '00000000-0000-4000-8000-0000000000aa');
upgrades.rememberArtistMbid('Yppah', null);
upgrades.saveReferenceAlbum({
  releaseGroupMbid: '20000000-0000-4000-8000-000000000001', releaseMbid: '30000000-0000-4000-8000-000000000001', title: 'Spirituality and Distortion',
  artist: 'Igorrr', artistMbid: '00000000-0000-4000-8000-0000000000aa', primaryType: 'Album', secondaryTypes: [], firstReleased: '2020-03-27',
  tracks: [
    { disc: 1, position: 1, recordingMbid: '40000000-0000-4000-8000-000000000001', title: 'Downgrade Desert', lengthMs: 240_000 },
    { disc: 1, position: 2, recordingMbid: '40000000-0000-4000-8000-000000000002', title: 'Camel Dancefloor', lengthMs: 200_000 },
  ],
});
upgrades.wantAlbum('20000000-0000-4000-8000-000000000001', 'lidarr');
upgrades.rememberAlbumLookup('Yppah', 'Radio Edit One', null);
upgrades.db.close();

const lyrics = new LyricsService(path.join(data, 'lyrics.db'));
lyrics.ready();
lyrics.close();
const lb = new ListenBrainz({ dbFile: path.join(data, 'listenbrainz.db'), token: '' });
lb.ready();
lb.close();
const shelf = new ShelfStore(path.join(data, 'discogs.db'));
shelf.ready();
shelf.close();

// --- images, and what a Jellyfin would hold --------------------------------------
for (const album of albums.slice(0, 15)) put(path.join(data, 'images', 'albums', `${album.id}.jpg`), sleeve(`img-${album.id}`));
for (const artist of artists.slice(0, 6)) put(path.join(data, 'images', 'artists', `${artist.id}.jpg`), sleeve(`img-${artist.id}`));
writeFileSync(path.join(out, 'jellyfin-items.json'), JSON.stringify(lib.map((file, i) => ({
  Id: `jf${String(i).padStart(3, '0')}`, Name: file.title, Album: file.album, AlbumId: `jfa-${file.album}`, Artists: [file.artist], AlbumArtists: [file.artist],
  RunTimeTicks: file.ms * 10_000, IndexNumber: file.track || undefined, ParentIndexNumber: 1, Container: file.codec, Path: `/eliot-media/music/${file.rel}`,
})), null, 1));
console.log(`fake world in ${out}: ${albums.length} albums, ${trackIds.length} tracks, ${lib.length} library files`);
