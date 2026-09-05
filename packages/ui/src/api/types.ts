// The shapes music-dump's API actually returns.
//
// Written from the server's handlers rather than guessed: fields are optional
// where the server genuinely omits them, because the old UI relied on `??`
// everywhere and silently rendered "undefined" when it was wrong.

export type QualityTier = 'hires' | 'lossless' | 'high' | 'standard' | 'low';
export type SourceKey = 'youtube' | 'cd' | 'external' | 'unknown';

/** Anything the badge helpers can decorate. */
export interface Badged {
  quality?: QualityTier | null;
  quality_label?: string | null;
  source?: string | null;
  source_detail?: string | null;
}

/** Rows that carry Spotify tombstones. */
export interface Tombstoned {
  removed_at?: string | null;
  unfollowed_at?: string | null;
  unsaved_at?: string | null;
  is_followed?: number | boolean | null;
  is_saved?: number | boolean | null;
}

export interface Track extends Badged, Tombstoned {
  id: string;
  name: string;
  artists?: string | null;
  artist_name?: string | null;
  album?: string | null;
  album_id?: string | null;
  image_url?: string | null;
  duration_ms?: number | null;
  disc_number?: number | null;
  track_number?: number | null;
  position?: number | null;
  added_at?: string | null;
  played_at?: string | null;
  liked?: number | boolean | null;
  rank?: number | null;
  standalone?: boolean | null;
  codec?: string | null;
  /** Radio only: a track the library does not hold yet. */
  pending?: boolean | null;
  recording_mbid?: string | null;
  release_mbid?: string | null;
  continuation_album_id?: string | null;
  /** Resolved from the credit string by the server; null when we hold no page. */
  artist_id?: string | null;
  /** What the album page for `album_id` calls itself. See PlayerBar. */
  album_name?: string | null;
}

export interface Album extends Badged, Tombstoned {
  id?: string;
  album_id?: string;
  name: string;
  artists?: string | null;
  release_date?: string | null;
  album_type?: string | null;
  album_group?: string | null;
  kind?: string | null;
  image_url?: string | null;
  label?: string | null;
  popularity?: number | null;
  total_tracks?: number | null;
  saved_at?: string | null;
  downloaded?: boolean | number | null;
  local?: boolean | null;
  /** Latest only: files on disk but not yet indexed. null means unknown. */
  playable?: boolean | null;
  added_at?: string | null;
  /** Releases only. */
  upcoming?: boolean | null;
}

export interface Artist extends Tombstoned {
  id: string;
  name: string;
  genres?: string | null;
  followers?: number | null;
  popularity?: number | null;
  image_url?: string | null;
  liked_count?: number | null;
  top_rank?: number | null;
  discog_synced_at?: string | null;
  rank?: number | null;
  n?: number | null;
}

export interface Playlist extends Tombstoned {
  source?: 'local' | 'spotify';
  id: string;
  name: string;
  description?: string | null;
  owner_name?: string | null;
  images?: string[] | null;
  synced_tracks?: number | null;
  total_tracks?: number | null;
}

export interface Overview {
  counts: {
    tasteArtists: number; liked: number; albums: number; playlists: number;
    totalPlays: number; appPlays: number; downloaded?: number;
  };
  plays30: number;
  playsPrev30: number;
  hours30: number;
  downloadsSyncedAt?: string | null;
  daily: StackPoint[];
  hours: Bucket[];
  weekdays: Bucket[];
  topArtists: Array<{ id: string; name: string; n: number }>;
  likedPerMonth: Array<{ month: string; n: number }>;
  lifetimeMonthly?: StackPoint[] | null;
  history: { rows?: number | null; hours?: number | null };
}

export interface StackPoint { spotify: number; app: number; d?: string; m?: string }
export interface Bucket { k: number; n: number }

export interface Provenance {
  total: number;
  scannedAt: string;
  tiers: Partial<Record<QualityTier, number>>;
  sources: Record<string, number>;
}

export interface Releases {
  releases: Album[];
  counts?: { upcoming?: number; missing?: number };
}

export interface Stats {
  genres?: Array<{ genre: string; n: number }>;
  syncedAt?: string | null;
  [k: string]: unknown;
}

export interface AlbumDetail {
  album: Album | null;
  artists: Array<{ id: string | null; name: string }>;
  tracks: Track[];
}

export interface ArtistDetail {
  artist: Artist | null;
  albums: Album[];
  liked: Track[];
  topRanks: Array<{ rank: number; time_range: string }>;
  events?: GigEvent[] | null;
}

export interface GigEvent {
  artist_id?: string | null;
  artist_name?: string | null;
  name?: string | null;
  venue?: string | null;
  city?: string | null;
  country?: string | null;
  datetime?: string | null;
  url?: string | null;
  image_url?: string | null;
}

export interface Events { near: GigEvent[]; elsewhere: GigEvent[]; countries: string[] }

export interface PlayerStatus {
  state: 'ready' | 'archive-offline' | 'unconfigured' | 'jellyfin-offline';
  detail: string;
  wakeAvailable?: boolean;
}

export interface ResolveResult {
  available: boolean;
  streamUrl?: string;
  track?: Track;
  reason?: 'archive-offline' | 'not-matched' | 'player-error';
  detail?: string;
  wakeAvailable?: boolean;
}

export interface LyricLine { time: number; text: string; words?: Array<{ time: number; text: string }> }
export interface Lyrics {
  available?: boolean;
  synced?: LyricLine[] | null;
  plain?: string | null;
  instrumental?: boolean;
  source?: 'jellyfin' | 'lrclib' | null;
}

export interface Continuation {
  available: boolean;
  reset?: boolean;
  reason?: 'same-artist' | 'same-vibe' | 'next-artist';
  album?: { id: string; name: string; artists: string };
  tracks?: Track[];
}

export interface RadioStation {
  tracks?: Track[];
  owned?: number;
  fresh?: number;
  error?: string;
  source?: 'similar' | 'similar+artist' | 'artist';
  seedTrack?: { title: string; artist: string } | null;
}

export interface ListenBrainz {
  enabled: boolean;
  user?: string;
  listens?: { submitted?: number };
}

export type UpgradeStatus =
  | 'pending_source' | 'queued' | 'working' | 'retry_wait'
  | 'upgraded' | 'already_lossless' | 'exhausted' | 'cancelled';

export interface UpgradeJob {
  id: number;
  status: UpgradeStatus;
  title: string;
  artist: string;
  album?: string | null;
  phase?: 'source' | 'upgrade' | null;
  source_mode?: string | null;
  batch_size?: number | null;
  track_number?: number | null;
  current_codec?: string | null;
  source_attempts: number;
  upgrade_attempts: number;
  max_attempts: number;
  next_attempt_at?: string | null;
  last_error?: string | null;
}

export interface Upgrades {
  jobs: UpgradeJob[];
  counts?: Partial<Record<UpgradeStatus, number>>;
}

export interface CdItem {
  release_id: number;
  artist: string;
  title: string;
  year?: string | number | null;
  format?: string | null;
  catno?: string | null;
  cover_url?: string | null;
  thumb_url?: string | null;
  status: 'shelf' | 'ripping' | 'ripped' | 'skip';
}

export interface Cds {
  items: CdItem[];
  counts: { shelf: number; ripping: number; ripped: number; total: number };
  sync: { synced_at?: string | null; username?: string | null };
  canSync: boolean;
  scope?: string;
  reconciled?: number;
}

export interface Wrapped {
  totals?: { plays: number; ms: number; tracks: number; artists: number };
  perMonth?: Array<{ month: string; n: number }>;
  topArtists: Array<{ artist_id?: string | null; artist_name: string; plays: number; ms: number; image_url?: string | null }>;
  topTracks: Array<{ id?: string | null; track_name: string; artist_name?: string | null; plays: number; ms: number }>;
  topAlbums: Array<{ album_id?: string | null; album_name: string; artist_name?: string | null; plays: number; image_url?: string | null }>;
  years?: string[];
}
