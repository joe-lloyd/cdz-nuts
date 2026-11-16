// Music found on Discogs, copied into the library's own tables.
//
// The library is the taste DB: artists, albums, tracks and the joins between
// them. Spotify fills it nightly; this adds rows for music Spotify never
// listed, so a band found on Discogs shows up in Library, in search and on
// its own pages exactly like everything else. Only metadata is written.
// Nothing here asks for audio: an app like would (the likes sweep grabs what
// is liked), which is why an added album is marked saved instead.
//
// Every row this writes has an id with a `discogs-` prefix, built from the
// Discogs id. That makes adding idempotent by construction, and it is how the
// Spotify exporter knows to leave these rows alone.
import type { Sql } from './sql.ts';
import { albumKey, cleanArtist, type DiscogsAlbum, type DiscogsAlbumKind, type DiscogsCredit } from './discogs.ts';
import { normalizeMusicText } from './jellyfin.ts';

export const DISCOGS_ID_PREFIX = 'discogs-';
export const DISCOGS_ARTIST_PREFIX = 'discogs-artist:';
export const DISCOGS_TRACK_PREFIX = 'discogs-track:';
/** A SQL LIKE pattern for every id this module writes. No `_` or `%` inside. */
export const DISCOGS_ID_LIKE = 'discogs-%';

/**
 * The artists put in the library from Discogs on purpose: added on their own,
 * or as an added album's artist. A guest credited on one track of someone
 * else's album gets an artist row (the credit needs one) but is not listed.
 * Kept in its own table because no column of `artists` means this without a
 * side effect: `is_followed` feeds the Lidarr import list and Spotify's
 * un-follow bookkeeping.
 */
export const DISCOGS_LIBRARY_ARTISTS = 'discogs_library_artists';

export const discogsArtistId = (id: number): string => `${DISCOGS_ARTIST_PREFIX}${id}`;
export const discogsAlbumId = (kind: DiscogsAlbumKind, id: number): string => `discogs-${kind}:${id}`;
export const isDiscogsId = (id: string): boolean => id.startsWith(DISCOGS_ID_PREFIX);

/** An album the library holds on disk, as the scanner reports it. */
export interface HeldAlbum {
  id: string;
  name: string;
  artists: string;
}

export interface AddedAlbum {
  /** The library's id for the album: the new row, or the one already held. */
  albumId: string;
  /** False when the library already held this album and nothing was written. */
  added: boolean;
  artistIds: string[];
  addedArtists: number;
  tracks: number;
}

export interface AddedArtist {
  artistId: string;
  added: boolean;
}

/** Spotify's album types, which the UI already knows how to label. */
function albumType(album: DiscogsAlbum): string {
  const formats = album.formats.map((format) => format.toLowerCase());
  if (formats.includes('single')) return 'single';
  if (formats.includes('ep')) return 'ep';
  if (formats.includes('compilation')) return 'compilation';
  return 'album';
}

/**
 * Disc and track numbers from a Discogs position. CDs number "1-3" or "CD2-4"
 * across discs; vinyl uses sides ("A1", "B2"), which play as one record.
 */
function numbering(album: DiscogsAlbum): { disc: number; track: number }[] {
  const counters = new Map<number, number>();
  return album.tracks.map((track) => {
    const disc = Number(/^(?:cd|disc|dvd)?\s*(\d+)[-.]\d+/i.exec(track.position)?.[1] ?? 1) || 1;
    const next = (counters.get(disc) ?? 0) + 1;
    counters.set(disc, next);
    return { disc, track: next };
  });
}

export class DiscogsLibrary {
  private readonly db: Sql;
  private readonly heldAlbums: () => readonly HeldAlbum[];
  private readonly now: () => number;
  private tableReady = false;

  constructor(db: Sql, heldAlbums: () => readonly HeldAlbum[] = () => [], now: () => number = Date.now) {
    this.db = db;
    this.heldAlbums = heldAlbums;
    this.now = now;
  }

  /** Creates the membership table. Never at module load: a Durable Object forbids SQL then. */
  ready(): void {
    if (this.tableReady) return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${DISCOGS_LIBRARY_ARTISTS} (
      artist_id TEXT PRIMARY KEY, added_at TEXT NOT NULL)`);
    this.tableReady = true;
  }

  /** Puts an artist in the library; true when they were not in it already. */
  private join(artistId: string): boolean {
    this.ready();
    return this.db.prepare(`INSERT OR IGNORE INTO ${DISCOGS_LIBRARY_ARTISTS} (artist_id, added_at) VALUES (?, ?)`)
      .run(artistId, new Date(this.now()).toISOString()).changes > 0;
  }

  /**
   * The library's id for an artist, or null when it has none. The Discogs id
   * matches first; then any artist already in the library under the same name,
   * whatever source brought it in, so a Spotify artist is never doubled.
   */
  findArtist(artist: DiscogsCredit): string | null {
    if (artist.id) {
      const own = this.db.prepare('SELECT id FROM artists WHERE id = ?').get(discogsArtistId(artist.id));
      if (own) return String(own.id);
    }
    const name = cleanArtist(artist.name);
    if (!name) return null;
    const named = this.db.prepare(`
      SELECT id FROM artists WHERE name = ? COLLATE NOCASE
      ORDER BY is_followed DESC, popularity DESC NULLS LAST, id LIMIT 1`).get(name);
    if (named) return String(named.id);
    const wanted = normalizeMusicText(name);
    const held = this.heldAlbums().find((album) => normalizeMusicText(album.artists) === wanted);
    return held ? `local-artist:${held.artists}` : null;
  }

  /**
   * The library's id for an album, or null. Matched by Discogs id (a release
   * also by its master, since both are the same album), then by artist and
   * title against what Spotify listed and what is on disk.
   */
  findAlbum(kind: DiscogsAlbumKind, id: number, artists: string[], title: string, masterId: number | null = null): string | null {
    const ids = [discogsAlbumId(kind, id)];
    if (masterId) ids.push(discogsAlbumId('master', masterId));
    for (const candidate of ids) {
      if (this.db.prepare('SELECT 1 FROM albums WHERE id = ?').get(candidate)) return candidate;
    }
    const names = artists.map(cleanArtist).filter(Boolean);
    for (const name of names) {
      const key = albumKey(name, title);
      if (!key) continue;
      const rows = this.db.prepare(`
        SELECT al.id, al.name, al.is_saved FROM albums al
        JOIN album_artists aa ON aa.album_id = al.id
        JOIN artists a ON a.id = aa.artist_id
        WHERE a.name = ? COLLATE NOCASE
        ORDER BY al.is_saved DESC, al.id`).all(name);
      const match = rows.find((row) => albumKey(name, String(row.name ?? '')) === key);
      if (match) return String(match.id);
      const held = this.heldAlbums().find((album) => albumKey(album.artists, album.name) === key);
      if (held) return held.id;
    }
    return null;
  }

  /** Writes the artist row unless one is already there; returns its id. */
  private ensureArtist(artist: DiscogsCredit, genres: string[], image: string | null = null): { id: string; added: boolean } {
    const existing = this.findArtist(artist);
    // An artist known only from files on disk has no row to link an album to.
    if (existing && !existing.startsWith('local-artist:')) return { id: existing, added: false };
    if (!artist.id) throw new Error(`Discogs gave no id for ${artist.name || 'an artist'}`);
    const id = discogsArtistId(artist.id);
    const result = this.db.prepare(`
      INSERT INTO artists (id, name, genres, image_url, is_followed)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(id) DO NOTHING`).run(id, cleanArtist(artist.name) || 'Unknown Artist', JSON.stringify(genres), image);
    return { id, added: result.changes > 0 };
  }

  /**
   * Adds one artist on its own, with no albums. Also how an artist the
   * library already has a row for (a guest credit, a Spotify crawl) is put in
   * the library on purpose. A second add is a no-op.
   */
  addArtist(artist: DiscogsCredit & { image?: string | null; genres?: string[] }): AddedArtist {
    this.ready();
    return this.db.transaction(() => {
      const { id, added } = this.ensureArtist(artist, artist.genres ?? [], artist.image ?? null);
      if (!added && artist.image) {
        this.db.prepare('UPDATE artists SET image_url = COALESCE(image_url, ?) WHERE id = ? AND id LIKE ?')
          .run(artist.image, id, DISCOGS_ID_LIKE);
      }
      const joined = this.join(id);
      return { artistId: id, added: added || joined };
    });
  }

  /**
   * Adds an album with its artists and tracks, as a saved album. Nothing is
   * written when the library already holds the album, by id or by name, and
   * every write is keyed on a Discogs id, so repeating it never duplicates.
   */
  addAlbum(album: DiscogsAlbum): AddedAlbum {
    if (!album.id) throw new Error('Discogs gave no id for that album');
    if (!album.artists.length) throw new Error('Discogs lists no artist for that album');
    this.ready();
    return this.db.transaction(() => {
      const names = album.artists.map((artist) => artist.name);
      const held = this.findAlbum(album.kind, album.id, names, album.title, album.masterId);
      if (held) {
        return { albumId: held, added: false, artistIds: [], addedArtists: 0, tracks: 0 };
      }
      // A release that belongs to a master is stored as the master, so adding
      // the CD and later the vinyl of the same album is still one album.
      const kind: DiscogsAlbumKind = album.kind === 'release' && album.masterId ? 'master' : album.kind;
      const albumId = discogsAlbumId(kind, kind === album.kind ? album.id : album.masterId!);
      const genres = [...album.genres, ...album.styles];
      let addedArtists = 0;
      const artistIds: string[] = [];
      for (const artist of album.artists) {
        const ensured = this.ensureArtist(artist, genres);
        if (ensured.added) addedArtists += 1;
        if (!artistIds.includes(ensured.id)) artistIds.push(ensured.id);
        // The album's own artists join the library with it; track guests do not.
        this.join(ensured.id);
      }
      const at = new Date(this.now()).toISOString();
      this.db.prepare(`
        INSERT INTO albums (id, name, album_type, release_date, release_date_precision,
                            total_tracks, label, image_url, is_saved, saved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(id) DO NOTHING`).run(
        albumId, album.title, albumType(album),
        album.released ?? (album.year ? String(album.year) : null),
        album.released ? 'day' : album.year ? 'year' : null,
        album.tracks.length, album.label ?? '', album.cover, at,
      );
      const linkAlbum = this.db.prepare('INSERT OR IGNORE INTO album_artists (album_id, artist_id, position) VALUES (?, ?, ?)');
      artistIds.forEach((artistId, position) => linkAlbum.run(albumId, artistId, position));

      const insertTrack = this.db.prepare(`
        INSERT INTO tracks (id, name, album_id, disc_number, track_number, duration_ms, explicit)
        VALUES (?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(id) DO NOTHING`);
      const linkTrack = this.db.prepare('INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)');
      const numbers = numbering(album);
      album.tracks.forEach((track, index) => {
        const trackId = `${DISCOGS_TRACK_PREFIX}${albumId.slice(DISCOGS_ID_PREFIX.length)}:${index + 1}`;
        insertTrack.run(trackId, track.title, albumId, numbers[index].disc, numbers[index].track, track.durationMs);
        // A track credited to a guest is linked to them; otherwise to the album's artists.
        const credited = track.artists.length
          ? track.artists.map((artist) => {
            const ensured = this.ensureArtist(artist, genres);
            if (ensured.added) addedArtists += 1;
            return ensured.id;
          })
          : artistIds;
        [...new Set(credited)].forEach((artistId, position) => linkTrack.run(trackId, artistId, position));
      });
      return { albumId, added: true, artistIds, addedArtists, tracks: album.tracks.length };
    });
  }
}
