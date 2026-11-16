// The physical shelf: CDs owned on disc, pulled from a Discogs collection so
// the app knows what still needs ripping.
//
// Discogs is the catalogue of record for physical media - it has the pressing,
// the catalogue number and the year, which is exactly what tells two editions
// of the same album apart. The collection is synced in, stored locally, and
// then cross-checked against the library so each disc shows as ripped or not.
// Ripping itself happens elsewhere; this only tracks it.
import path from 'node:path';
import { openSql, type Sql } from './sql.ts';
import { normalizeMusicText } from './jellyfin.ts';

export const DISCOGS_FILE = process.env.DISCOGS_DB
  ?? path.join(import.meta.dirname, '..', 'data', 'discogs.db');

const API = 'https://api.discogs.com';
// A test or a headless verification run points the client at a stand-in for
// Discogs. Unset in every real deployment.
const API_OVERRIDE = process.env.DISCOGS_API_URL ?? '';
// Discogs rejects requests without a descriptive agent, and asks that it
// identify the application rather than impersonate a browser.
const AGENT = process.env.DISCOGS_USER_AGENT ?? 'cdz-nutz/1.0 (+https://music.home.arpa)';

export type ShelfStatus = 'shelf' | 'ripping' | 'ripped' | 'skip';
export const SHELF_STATUSES: ShelfStatus[] = ['shelf', 'ripping', 'ripped', 'skip'];

export interface ShelfItem {
  release_id: number;
  artist: string;
  title: string;
  year: number | null;
  format: string | null;
  label: string | null;
  catno: string | null;
  thumb_url: string | null;
  cover_url: string | null;
  genres: string | null;      // JSON array
  status: ShelfStatus;
  rip_path: string | null;
  notes: string | null;
  added_at: string;
  updated_at: string;
}

export class DiscogsError extends Error {
  readonly status: number;

  // Written out rather than declared as a constructor parameter property:
  // Node's type stripping runs without a full compiler and rejects those.
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type DiscogsAlbumKind = 'master' | 'release';

/** An artist as a catalogue search or lookup shows it. */
export interface CatalogueArtist {
  id: number;
  name: string;
  image: string | null;
}

/** An album as a catalogue search or an artist's discography shows it. */
export interface CatalogueAlbum {
  kind: DiscogsAlbumKind;
  id: number;
  title: string;
  artist: string;
  year: number | null;
  image: string | null;
  format: string | null;
  genres: string[];
}

export interface DiscogsCredit {
  id: number;
  name: string;
}

export interface DiscogsTrack {
  position: string;
  title: string;
  durationMs: number | null;
  artists: DiscogsCredit[];
}

/** A master or release, flattened to what the library stores. */
export interface DiscogsAlbum {
  kind: DiscogsAlbumKind;
  id: number;
  title: string;
  year: number | null;
  /** The release date when Discogs has one finer than the year. */
  released: string | null;
  artists: DiscogsCredit[];
  genres: string[];
  styles: string[];
  label: string | null;
  formats: string[];
  cover: string | null;
  /** The master a release belongs to, or the main release of a master. */
  masterId: number | null;
  mainRelease: number | null;
  tracks: DiscogsTrack[];
}

interface SearchHit {
  id?: number;
  type?: string;
  title?: string;
  thumb?: string;
  cover_image?: string;
  year?: string | number;
  master_id?: number;
  format?: unknown[];
  genre?: unknown[];
}

interface RawImage { type?: string; uri?: string; uri150?: string }
interface RawCredit { id?: number; name?: string; anv?: string }
interface RawTrack {
  position?: string;
  title?: string;
  duration?: string;
  type_?: string;
  artists?: RawCredit[];
  sub_tracks?: RawTrack[];
}
interface RawAlbum {
  id?: number;
  title?: string;
  year?: number;
  released?: string;
  artists?: RawCredit[];
  genres?: string[];
  styles?: string[];
  labels?: { name?: string }[];
  formats?: { name?: string; descriptions?: string[] }[];
  images?: RawImage[];
  master_id?: number;
  main_release?: number;
  tracklist?: RawTrack[];
}

const nonEmpty = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
};

/** Search hits title albums "Artist - Title". */
function splitTitle(title: string): { artist: string; title: string } {
  const dash = title.indexOf(' - ');
  return dash > 0
    ? { artist: cleanArtist(title.slice(0, dash)), title: title.slice(dash + 3).trim() || 'Untitled' }
    : { artist: '', title: title.trim() || 'Untitled' };
}

function primaryImage(images: RawImage[] | undefined): string | null {
  const list = images ?? [];
  const best = list.find((image) => image.type === 'primary') ?? list[0];
  return nonEmpty(best?.uri) ?? nonEmpty(best?.uri150);
}

/** "4:35" or "1:02:03" to milliseconds; Discogs leaves it blank when unknown. */
export function durationMs(text: string | undefined): number | null {
  const parts = String(text ?? '').trim().split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return seconds > 0 ? seconds * 1000 : null;
}

const credits = (list: RawCredit[] | undefined): DiscogsCredit[] => (list ?? [])
  .map((credit) => ({ id: Number(credit.id ?? 0), name: cleanArtist(String(credit.name ?? '')) }))
  .filter((credit) => credit.name);

/**
 * Discogs tracklists mix real tracks with headings ("Bonus Tracks") and
 * index tracks that group sub-tracks. Only playable entries become tracks.
 */
function flattenTracks(list: RawTrack[] | undefined): DiscogsTrack[] {
  const tracks: DiscogsTrack[] = [];
  for (const entry of list ?? []) {
    const type = entry.type_ ?? 'track';
    if (type === 'heading') continue;
    if (type === 'index') {
      tracks.push(...flattenTracks(entry.sub_tracks));
      continue;
    }
    const title = String(entry.title ?? '').trim();
    if (!title) continue;
    tracks.push({
      position: String(entry.position ?? '').trim(),
      title,
      durationMs: durationMs(entry.duration),
      artists: credits(entry.artists),
    });
  }
  return tracks;
}

export function toDiscogsAlbum(kind: DiscogsAlbumKind, raw: RawAlbum): DiscogsAlbum {
  const released = nonEmpty(raw.released);
  return {
    kind,
    id: Number(raw.id ?? 0),
    title: String(raw.title ?? '').trim() || 'Untitled',
    year: Number(raw.year) || null,
    // "1999-00-00" is how Discogs writes a year-only date.
    released: released && /^\d{4}-\d{2}-\d{2}$/.test(released) && !released.endsWith('-00') ? released : null,
    artists: credits(raw.artists),
    genres: (raw.genres ?? []).map(String),
    styles: (raw.styles ?? []).map(String),
    label: nonEmpty(raw.labels?.[0]?.name),
    formats: (raw.formats ?? []).flatMap((format) => [format.name, ...(format.descriptions ?? [])])
      .filter((name): name is string => typeof name === 'string' && !!name),
    cover: primaryImage(raw.images),
    masterId: kind === 'release' ? Number(raw.master_id ?? 0) || null : Number(raw.id ?? 0) || null,
    mainRelease: Number(raw.main_release ?? 0) || null,
    tracks: flattenTracks(raw.tracklist),
  };
}

export interface CollectionRelease {
  id: number;
  basic_information?: {
    id?: number;
    title?: string;
    year?: number;
    thumb?: string;
    cover_image?: string;
    artists?: { name?: string }[];
    labels?: { name?: string; catno?: string }[];
    formats?: { name?: string; qty?: string; descriptions?: string[] }[];
    genres?: string[];
  };
}

/** "Joe Bloggs (2)" is how Discogs disambiguates same-named artists. */
export function cleanArtist(name: string): string {
  return name.replace(/\s*\(\d+\)$/, '').trim();
}

function formatOf(release: CollectionRelease['basic_information']): string | null {
  const first = release?.formats?.[0];
  if (!first) return null;
  const extra = (first.descriptions ?? []).filter((d) => d && d !== first.name);
  return [first.name, ...extra].filter(Boolean).join(', ') || null;
}

export function toShelfItem(release: CollectionRelease): Omit<ShelfItem, 'status' | 'rip_path' | 'notes' | 'added_at' | 'updated_at'> {
  const info = release.basic_information ?? {};
  const artists = (info.artists ?? []).map((a) => cleanArtist(String(a.name ?? ''))).filter(Boolean);
  const label = info.labels?.[0];
  return {
    release_id: Number(info.id ?? release.id),
    artist: artists.join(', ') || 'Unknown Artist',
    title: String(info.title ?? '').trim() || 'Untitled',
    year: info.year ? Number(info.year) : null,
    format: formatOf(info),
    label: label?.name ? String(label.name) : null,
    catno: label?.catno ? String(label.catno) : null,
    thumb_url: info.thumb || null,
    cover_url: info.cover_image || info.thumb || null,
    genres: info.genres?.length ? JSON.stringify(info.genres) : null,
  };
}

/**
 * Discogs has two credential shapes and they are NOT interchangeable.
 *
 *  - A **consumer key + secret** identifies an *application*. It authenticates
 *    requests to public endpoints (catalogue search, release lookup) at the
 *    full rate limit, and that is all. It cannot read anyone's collection,
 *    because it does not identify a person.
 *  - A **personal access token** identifies *you*. It is what unlocks
 *    /oauth/identity and the collection endpoints.
 *
 * The alternative to a personal token is the full OAuth 1.0a dance
 * (request token -> browser authorize -> verifier -> access token), which for
 * a single-user homelab app buys nothing over the token you can generate with
 * one click on the same settings page.
 *
 * Both are supported here: whichever is configured is used, with the personal
 * token preferred when both are present.
 */
export type DiscogsScope = 'none' | 'catalogue' | 'account';

/** How a request behaves when Discogs pushes back. */
interface RequestOptions {
  /**
   * Sleep through one 429 and try again. Right for a sync the user started and
   * is happy to wait on; wrong for a search box, where a half-minute hang reads
   * as broken. Interactive calls fail fast with the wait in the message.
   */
  wait?: boolean;
  /** Keep the answer for a few minutes: catalogue entries barely change. */
  cache?: boolean;
}

export interface DiscogsClientOptions {
  /** Base URL of the API. Defaults to Discogs itself. */
  api?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_ENTRIES = 200;

export class DiscogsClient {
  private readonly token: string;
  private readonly key: string;
  private readonly secret: string;
  private readonly api: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    token = process.env.DISCOGS_TOKEN ?? '',
    key = process.env.DISCOGS_CONSUMER_KEY ?? '',
    secret = process.env.DISCOGS_CONSUMER_SECRET ?? '',
    options: DiscogsClientOptions = {},
  ) {
    this.token = token.trim();
    this.key = key.trim();
    this.secret = secret.trim();
    this.api = (options.api || API_OVERRIDE || API).replace(/\/+$/, '');
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  /** What the configured credentials can actually reach. */
  get scope(): DiscogsScope {
    if (this.token) return 'account';
    if (this.key && this.secret) return 'catalogue';
    return 'none';
  }

  get configured(): boolean {
    return this.scope !== 'none';
  }

  /** Collection sync needs a personal token; search does not. */
  get canReadCollection(): boolean {
    return this.scope === 'account';
  }

  private authorization(): string {
    return this.token
      ? `Discogs token=${this.token}`
      : `Discogs key=${this.key}, secret=${this.secret}`;
  }

  private async request<T>(
    pathname: string,
    params: Record<string, string> = {},
    options: RequestOptions = {},
  ): Promise<T> {
    if (!this.configured) throw new DiscogsError('Discogs is not configured on this server', 503);
    const url = new URL(this.api + pathname);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const cacheKey = url.toString();
    if (options.cache) {
      const hit = this.cache.get(cacheKey);
      if (hit && this.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
      this.cache.delete(cacheKey);
    }
    const wait = options.wait ?? true;

    // 60 requests/minute authenticated. A collection sync is a handful of
    // pages, so one polite wait-and-retry is enough to ride out a 429 rather
    // than failing a sync the user asked for.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let res: Response;
      try {
        res = await this.fetcher(url, {
          headers: { authorization: this.authorization(), 'user-agent': AGENT },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        // Neither the URL nor the error text is passed on: both are about
        // the network, and the request carried the credential.
        const timedOut = (err as Error)?.name === 'TimeoutError';
        throw new DiscogsError(timedOut ? 'Discogs did not answer in time' : 'Discogs is unavailable right now', timedOut ? 504 : 502);
      }
      if (res.status === 429) {
        const pause = Math.min(30, Number(res.headers.get('retry-after') ?? 5) || 5);
        if (attempt === 0 && wait) {
          await new Promise((resolve) => setTimeout(resolve, pause * 1000));
          continue;
        }
        throw new DiscogsError(`Discogs rate limit reached. Try again in ${pause} seconds.`, 429);
      }
      if (!res.ok) {
        // 401 on a consumer key/secret is not a bad credential, it is the
        // wrong *kind* of credential; say which so it is actionable.
        const detail = res.status === 404
          ? 'Discogs has no such entry'
          : res.status >= 500
            ? 'Discogs is unavailable right now'
            : res.status !== 401
              ? `Discogs returned ${res.status}`
              : this.canReadCollection
                ? 'Discogs rejected the personal access token'
                : 'This endpoint needs a personal access token, not a consumer key and secret';
        throw new DiscogsError(detail, res.status >= 500 ? 502 : res.status);
      }
      const value = await res.json() as T;
      if (options.cache) {
        if (this.cache.size >= CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
        this.cache.set(cacheKey, { at: this.now(), value });
      }
      return value;
    }
    throw new DiscogsError('Discogs rate limit exceeded', 429);
  }

  /** The token's own account - saves asking for a username separately. */
  identity(): Promise<{ username: string; id: number }> {
    if (!this.canReadCollection) {
      throw new DiscogsError(
        'Collection sync needs a personal access token. Generate one at '
        + 'discogs.com/settings/developers and set DISCOGS_TOKEN; a consumer '
        + 'key and secret can only search the catalogue.',
        403,
      );
    }
    return this.request('/oauth/identity');
  }

  /**
   * Every release in the collection. Folder 0 is Discogs' "All" folder, so
   * this covers every custom folder without enumerating them.
   */
  async collection(username: string, onPage?: (page: number, pages: number) => void): Promise<CollectionRelease[]> {
    const all: CollectionRelease[] = [];
    let page = 1;
    let pages = 1;
    do {
      const body = await this.request<{
        pagination?: { pages?: number };
        releases?: CollectionRelease[];
      }>(`/users/${encodeURIComponent(username)}/collection/folders/0/releases`, {
        page: String(page),
        per_page: '100',
        sort: 'artist',
      });
      pages = Number(body.pagination?.pages ?? 1);
      all.push(...(body.releases ?? []));
      onPage?.(page, pages);
      page += 1;
    } while (page <= pages && page <= 50); // 5000 discs is well past any shelf
    return all;
  }

  /** Free-text catalogue search, for adding a disc the collection is missing. */
  async search(term: string): Promise<CollectionRelease[]> {
    const body = await this.request<{ results?: Record<string, unknown>[] }>('/database/search', {
      q: term,
      type: 'release',
      format: 'CD',
      per_page: '25',
    });
    // Search results are shaped differently from collection entries; fold them
    // into the same shape so one renderer handles both.
    return (body.results ?? []).map((result) => {
      const title = String(result.title ?? '');
      const dash = title.indexOf(' - ');
      return {
        id: Number(result.id ?? 0),
        basic_information: {
          id: Number(result.id ?? 0),
          title: dash > 0 ? title.slice(dash + 3) : title,
          year: result.year ? Number(result.year) : undefined,
          thumb: String(result.thumb ?? ''),
          cover_image: String(result.cover_image ?? result.thumb ?? ''),
          artists: dash > 0 ? [{ name: title.slice(0, dash) }] : [],
          labels: Array.isArray(result.label)
            ? [{ name: String(result.label[0] ?? ''), catno: String(result.catno ?? '') }]
            : [],
          formats: Array.isArray(result.format) ? [{ name: String(result.format[0] ?? 'CD') }] : [],
          genres: Array.isArray(result.genre) ? result.genre.map(String) : [],
        },
      };
    });
  }

  /**
   * Artists and albums matching a free-text query, for finding music the
   * library does not hold yet. Three calls, made together: artists, masters
   * (an album across all its pressings), and releases, because a small band's
   * only record often has no master. A release that belongs to a master is
   * folded into that master, so one album shows once.
   */
  async searchCatalogue(term: string): Promise<{ artists: CatalogueArtist[]; albums: CatalogueAlbum[] }> {
    const ask = (type: string, perPage: number) => this.request<{ results?: SearchHit[] }>(
      '/database/search', { q: term, type, per_page: String(perPage) }, { wait: false, cache: true },
    ).then((body) => body.results ?? []);
    const [artistHits, masterHits, releaseHits] = await Promise.all([ask('artist', 8), ask('master', 20), ask('release', 20)]);
    const artists = artistHits.map((hit): CatalogueArtist => ({
      id: Number(hit.id ?? 0),
      name: cleanArtist(String(hit.title ?? '')),
      image: nonEmpty(hit.cover_image) ?? nonEmpty(hit.thumb),
    })).filter((artist) => artist.id > 0 && artist.name);
    const albums: CatalogueAlbum[] = [];
    const seen = new Set<string>();
    for (const hit of [...masterHits, ...releaseHits]) {
      const master = Number(hit.master_id ?? 0);
      const kind: DiscogsAlbumKind = hit.type === 'master' || master > 0 ? 'master' : 'release';
      const id = hit.type === 'master' ? Number(hit.id ?? 0) : kind === 'master' ? master : Number(hit.id ?? 0);
      const key = `${kind}:${id}`;
      if (!id || seen.has(key)) continue;
      seen.add(key);
      const { artist, title } = splitTitle(String(hit.title ?? ''));
      albums.push({
        kind, id, title, artist,
        year: Number(hit.year) || null,
        image: nonEmpty(hit.cover_image) ?? nonEmpty(hit.thumb),
        format: Array.isArray(hit.format) ? hit.format.map(String).join(', ') || null : null,
        genres: Array.isArray(hit.genre) ? hit.genre.map(String) : [],
      });
    }
    return { artists, albums: albums.slice(0, 30) };
  }

  /** One album with its tracklist, from a master or a release. */
  async album(kind: DiscogsAlbumKind, id: number): Promise<DiscogsAlbum> {
    const raw = await this.request<RawAlbum>(`/${kind}s/${id}`, {}, { wait: false, cache: true });
    return toDiscogsAlbum(kind, raw);
  }

  /**
   * An album complete enough to store. A master carries no label, so its main
   * release is asked for that - one more call, made only when adding.
   */
  async albumForLibrary(kind: DiscogsAlbumKind, id: number): Promise<DiscogsAlbum> {
    const album = await this.album(kind, id);
    if (kind === 'master' && !album.label && album.mainRelease) {
      try {
        const main = await this.album('release', album.mainRelease);
        return { ...album, label: main.label, released: main.released ?? album.released, formats: main.formats };
      } catch (err) {
        // The label is a nicety; the album is worth adding without it.
        if (!(err instanceof DiscogsError)) throw err;
      }
    }
    return album;
  }

  async artist(id: number): Promise<CatalogueArtist & { profile: string | null }> {
    const raw = await this.request<{ id?: number; name?: string; profile?: string; images?: RawImage[] }>(
      `/artists/${id}`, {}, { wait: false, cache: true },
    );
    return {
      id: Number(raw.id ?? id),
      name: cleanArtist(String(raw.name ?? '')) || 'Unknown Artist',
      image: primaryImage(raw.images),
      profile: nonEmpty(raw.profile),
    };
  }

  /** The albums an artist made (main credits only, not guest spots), newest first. */
  async artistAlbums(id: number): Promise<CatalogueAlbum[]> {
    const body = await this.request<{ releases?: Record<string, unknown>[] }>(
      `/artists/${id}/releases`, { sort: 'year', sort_order: 'desc', per_page: '50' }, { wait: false, cache: true },
    );
    const albums: CatalogueAlbum[] = [];
    for (const entry of body.releases ?? []) {
      if (entry.role && entry.role !== 'Main') continue;
      const kind: DiscogsAlbumKind = entry.type === 'master' ? 'master' : 'release';
      const albumId = Number(entry.id ?? 0);
      if (!albumId) continue;
      albums.push({
        kind, id: albumId,
        title: String(entry.title ?? '').trim() || 'Untitled',
        artist: cleanArtist(String(entry.artist ?? '')),
        year: Number(entry.year) || null,
        image: nonEmpty(entry.thumb),
        format: nonEmpty(entry.format),
        genres: [],
      });
    }
    return albums;
  }
}

/** Match key for "do I already have this album ripped?". */
export function albumKey(artist: string, title: string): string {
  const lead = String(artist ?? '').split(/,| & | feat\.? | ft\.? /i)[0] ?? '';
  // Discogs titles carry edition noise the library folder never has.
  const bare = String(title ?? '')
    .replace(/\s*[([][^)\]]*(edition|remaster|reissue|deluxe|disc|cd\s*\d)[^)\]]*[)\]]/gi, '')
    .trim();
  const a = normalizeMusicText(lead);
  const t = normalizeMusicText(bare);
  return a && t ? `${a} ${t}` : '';
}

export class ShelfStore {
  private db: Sql | null = null;
  private readonly dbFile: string;
  private readonly now: () => number;

  constructor(dbFile?: string, now: () => number = Date.now) {
    this.dbFile = dbFile ?? DISCOGS_FILE;
    this.now = now;
  }

  private handle(): Sql {
    if (!this.db) {
      this.db = openSql(this.dbFile);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS cd_shelf (
          release_id INTEGER PRIMARY KEY,
          artist TEXT NOT NULL,
          title TEXT NOT NULL,
          year INTEGER,
          format TEXT,
          label TEXT,
          catno TEXT,
          thumb_url TEXT,
          cover_url TEXT,
          genres TEXT,
          status TEXT NOT NULL DEFAULT 'shelf'
            CHECK (status IN ('shelf', 'ripping', 'ripped', 'skip')),
          rip_path TEXT,
          notes TEXT,
          added_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS shelf_status ON cd_shelf(status);

        CREATE TABLE IF NOT EXISTS shelf_sync (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          username TEXT,
          synced_at TEXT,
          released INTEGER
        );
      `);
    }
    return this.db;
  }

  /** Creates the tables now, so nothing queries a database that lacks them. */
  ready(): void {
    this.handle();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /**
   * Merge a synced collection in. Catalogue fields are refreshed every sync,
   * but status/notes/rip_path are the user's and are never overwritten.
   */
  sync(releases: CollectionRelease[], username: string): { added: number; updated: number; removed: number } {
    const db = this.handle();
    const at = new Date(this.now()).toISOString();
    const existing = new Set((db.prepare('SELECT release_id FROM cd_shelf').all() as { release_id: number }[])
      .map((row) => row.release_id));
    const insert = db.prepare(`
      INSERT INTO cd_shelf
        (release_id, artist, title, year, format, label, catno, thumb_url, cover_url,
         genres, status, added_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shelf', ?, ?)
      ON CONFLICT(release_id) DO UPDATE SET
        artist = excluded.artist, title = excluded.title, year = excluded.year,
        format = excluded.format, label = excluded.label, catno = excluded.catno,
        thumb_url = excluded.thumb_url, cover_url = excluded.cover_url,
        genres = excluded.genres, updated_at = excluded.updated_at
    `);
    let added = 0;
    let updated = 0;
    const seen = new Set<number>();
    return db.transaction(() => {
      for (const release of releases) {
        const item = toShelfItem(release);
        if (!item.release_id) continue;
        seen.add(item.release_id);
        if (existing.has(item.release_id)) updated += 1; else added += 1;
        insert.run(
          item.release_id, item.artist, item.title, item.year, item.format,
          item.label, item.catno, item.thumb_url, item.cover_url, item.genres, at, at,
        );
      }
      // A disc sold or removed on Discogs should leave the shelf too, unless
      // it has already been ripped - then the library still has it and the
      // record is worth keeping.
      let removed = 0;
      const drop = db.prepare("DELETE FROM cd_shelf WHERE release_id = ? AND status IN ('shelf', 'skip')");
      for (const id of existing) {
        if (!seen.has(id)) removed += drop.run(id).changes ? 1 : 0;
      }
      db.prepare(`
        INSERT INTO shelf_sync (id, username, synced_at, released) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET username = excluded.username,
          synced_at = excluded.synced_at, released = excluded.released
      `).run(username, at, seen.size);
      return { added, updated, removed };
    });
  }

  /** Add a single release found through search rather than the collection. */
  add(release: CollectionRelease): ShelfItem | null {
    const item = toShelfItem(release);
    if (!item.release_id) return null;
    const at = new Date(this.now()).toISOString();
    this.handle().prepare(`
      INSERT INTO cd_shelf
        (release_id, artist, title, year, format, label, catno, thumb_url, cover_url,
         genres, status, added_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shelf', ?, ?)
      ON CONFLICT(release_id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(
      item.release_id, item.artist, item.title, item.year, item.format,
      item.label, item.catno, item.thumb_url, item.cover_url, item.genres, at, at,
    );
    return this.get(item.release_id);
  }

  get(releaseId: number): ShelfItem | null {
    return (this.handle().prepare('SELECT * FROM cd_shelf WHERE release_id = ?')
      .get(releaseId) as ShelfItem | undefined) ?? null;
  }

  list(): ShelfItem[] {
    return this.handle().prepare(
      'SELECT * FROM cd_shelf ORDER BY artist COLLATE NOCASE, year, title COLLATE NOCASE',
    ).all() as ShelfItem[];
  }

  setStatus(releaseId: number, status: ShelfStatus, ripPath?: string | null): ShelfItem | null {
    if (!SHELF_STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
    const at = new Date(this.now()).toISOString();
    this.handle().prepare(
      'UPDATE cd_shelf SET status = ?, rip_path = COALESCE(?, rip_path), updated_at = ? WHERE release_id = ?',
    ).run(status, ripPath ?? null, at, releaseId);
    return this.get(releaseId);
  }

  remove(releaseId: number): boolean {
    return this.handle().prepare('DELETE FROM cd_shelf WHERE release_id = ?').run(releaseId).changes > 0;
  }

  lastSync(): { username: string | null; synced_at: string | null; released: number | null } {
    const row = this.handle().prepare('SELECT username, synced_at, released FROM shelf_sync WHERE id = 1').get();
    return (row as { username: string | null; synced_at: string | null; released: number | null })
      ?? { username: null, synced_at: null, released: null };
  }

  /**
   * Flip shelf discs to ripped when the library grows a matching album.
   * Only moves 'shelf' -> 'ripped'; a manual 'skip' or an in-progress
   * 'ripping' is the user's state and is left alone.
   */
  reconcile(libraryKeys: Set<string>): number {
    const db = this.handle();
    const at = new Date(this.now()).toISOString();
    const stmt = db.prepare("UPDATE cd_shelf SET status = 'ripped', updated_at = ? WHERE release_id = ?");
    let flipped = 0;
    for (const item of this.list()) {
      if (item.status !== 'shelf') continue;
      if (!libraryKeys.has(albumKey(item.artist, item.title))) continue;
      stmt.run(at, item.release_id);
      flipped += 1;
    }
    return flipped;
  }
}
