import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { artUrl, day, genres as parseGenres, initial } from '../lib/format.ts';
import type { Badged, QualityTier, Tombstoned, Track } from '../api/types.ts';
import { post } from '../api/client.ts';
import { player, usePlayer } from '../player/usePlayer.ts';
import { usePlayFromScope } from './PlayScope.tsx';

/**
 * Whether this track is the one playing, and how.
 *
 * Derived from the engine rather than by re-rendering a view: one track can be
 * on screen several times at once, and the player outlives navigation. The
 * class goes on BOTH the row (which tints) and the play button (which swaps
 * its glyph for animated equaliser bars) -- putting it only on the row is what
 * made the button stop reacting.
 */
export function useNowPlaying(id: string): '' | ' playing' | ' paused' {
  const p = usePlayer();
  if (p.currentId !== id) return '';
  return p.state === 'playing' ? ' playing' : ' paused';
}

/**
 * Do we actually hold this file?
 *
 * `quality` is attached by decorateBadges to any track-shaped row the
 * provenance scanner has seen, so its absence means there is no local file.
 * That is the same signal the fidelity badge uses, which is why a track
 * without one shows neither a badge nor a play button.
 */
export const isHeld = (track: Badged): boolean => Boolean(track.quality);

export const PLAY_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z" /></svg>
);

/**
 * Cover art, with the fallback chain the whole app shares: the copy this app
 * serves (which survives Spotify deletions), then the CDN url, then a letter.
 */
export function Pic({ kind, id, cdn, name, overlay }: {
  kind: 'albums' | 'artists';
  id?: string | null | undefined;
  cdn?: string | null | undefined;
  name?: string | null | undefined;
  overlay?: ReactNode | undefined;
}) {
  // An id names art we host; without one the remote url IS the source, which is
  // how an unreleased record still shows its Cover Art Archive sleeve.
  const primary = id ? artUrl(kind, id) : (cdn ?? '');
  const [src, setSrc] = useState(primary);
  const [failed, setFailed] = useState(!primary);

  return (
    <div className="pic">
      {failed ? null : (
        <img
          src={src} alt="" loading="lazy"
          onError={() => {
            if (cdn && src !== cdn) setSrc(cdn);
            else setFailed(true);
          }}
        />
      )}
      <div className="ph" style={failed ? undefined : { display: 'none' }}>{initial(name)}</div>
      {overlay}
    </div>
  );
}

export const Chip = ({ text, bad }: { text: string; bad?: boolean | undefined }) => (
  <span className={`chip${bad ? ' bad' : ''}`}>{text}</span>
);

export const Chips = ({ children }: { children: ReactNode[] }) => {
  const kept = children.filter(Boolean);
  return kept.length ? <div className="chips">{kept}</div> : null;
};

export const GenreChips = ({ json, n = 3 }: { json?: string | null | undefined; n?: number | undefined }) => {
  const list = parseGenres(json, n);
  return list.length ? <div className="chips">{list.map((g) => <Chip key={g} text={g} />)}</div> : null;
};

/** Tombstones: history is kept, these say what changed and when. */
export function Badges({ row }: { row: Tombstoned }) {
  const items = [
    row.removed_at ? <Chip key="r" text={`removed from spotify ${day(row.removed_at)}`} bad /> : null,
    row.unfollowed_at && !row.is_followed ? <Chip key="u" text={`unfollowed ${day(row.unfollowed_at)}`} /> : null,
    row.unsaved_at && !row.is_saved ? <Chip key="s" text={`unsaved ${day(row.unsaved_at)}`} /> : null,
  ].filter(Boolean);
  return items.length ? <div className="chips">{items}</div> : null;
}

const QUALITY_META: Record<QualityTier, { bars: number; cls: string; tip: string }> = {
  hires: { bars: 4, cls: 'q-hires', tip: 'Hi-res lossless' },
  lossless: { bars: 4, cls: 'q-lossless', tip: 'Lossless' },
  high: { bars: 3, cls: 'q-high', tip: 'High-bitrate lossy' },
  standard: { bars: 2, cls: 'q-standard', tip: 'Standard lossy — YouTube grade' },
  low: { bars: 1, cls: 'q-low', tip: 'Low bitrate' },
};

// Anything that is not one of the named local paths renders as a single neutral
// identity. Provenance still records exactly which source produced each file --
// this repository is public and the UI has no reason to publish the breakdown.
const SOURCE_META = {
  youtube: { tip: 'From a web stream', path: <><rect x="2.5" y="5" width="19" height="14" rx="4.5" /><path d="m10.2 8.9 5.2 3.1-5.2 3.1z" /></> },
  cd: { tip: 'Ripped from CD', path: <><circle cx="12" cy="12" r="8.6" /><circle cx="12" cy="12" r="2.3" /></> },
  external: { tip: 'From an external source', path: <><path d="M7.4 15.6a3.7 3.7 0 0 1 .7-7.3 4.8 4.8 0 0 1 9.1 1.2 3.3 3.3 0 0 1-.2 6.1" /><path d="M12 11.5v7.2m-2.7-2.7L12 18.7l2.7-2.7" /></> },
  unknown: { tip: 'Source not recorded', path: <><circle cx="12" cy="12" r="8.6" /><path d="M9.7 9.7a2.4 2.4 0 1 1 2.6 3.4v1" /><path d="M12.3 16.6v.01" /></> },
} as const;

const sourceKey = (k?: string | null) =>
  (k === 'youtube' || k === 'cd' || k === 'unknown' ? k : 'external') as keyof typeof SOURCE_META;

/**
 * Tier encoded three ways at once — filled bars, colour, and the literal
 * figure — so it survives being read at 9px and does not depend on telling
 * magenta from gold.
 */
export function MediaBadges({ row }: { row: Badged }) {
  const quality = row.quality ? QUALITY_META[row.quality] : null;
  const key = sourceKey(row.source);
  const source = SOURCE_META[key];
  // `source` is also set on play rows to mark where a play happened, which is a
  // different vocabulary — only render it when it names a real pipeline.
  const showSource = Boolean(row.quality);

  return (
    <div className="song-badges">
      {quality ? (
        <span className={`q-badge ${quality.cls}`} title={`${quality.tip}${row.quality_label ? ` · ${row.quality_label}` : ''}`}>
          <span className="q-bars">{[1, 2, 3, 4].map((n) => <i key={n} className={n <= quality.bars ? 'on' : undefined} />)}</span>
          {row.quality_label ? <b>{row.quality_label}</b> : null}
        </span>
      ) : null}
      {showSource ? (
        <span className={`s-badge s-${key}`} title={row.source_detail && key !== 'external' ? `${source.tip} · ${row.source_detail}` : source.tip}>
          <svg viewBox="0 0 24 24" aria-hidden="true">{source.path}</svg>
        </span>
      ) : null}
    </div>
  );
}

const DOWNLOAD_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M11 3h2v8h3l-4 4-4-4h3z" /><path d="M5 19h14v2H5z" />
  </svg>
);

/**
 * Play this, or go and get it.
 *
 * A track with no local file cannot be queued, so it gets the download control
 * instead of a play button -- shaped the same, so the row reads identically
 * before and after the file lands. Deliberately not class `.track-play`: the
 * player builds queues from those.
 *
 * Pressing it IS the request. Nobody asks for a song they do not want, so this
 * sends the same "get me this" the player used to send when you pressed play
 * on something missing; it just says so up front now instead of after.
 */
export function PlayControl({ track }: { track: Track }) {
  const play = usePlayFromScope();
  const state = useNowPlaying(track.id);
  const [requested, setRequested] = useState(false);
  if (!track.id) return null;

  if (!isHeld(track)) {
    return (
      <button
        className={`radio-get${requested ? ' queued' : ''}`} type="button" disabled={requested}
        aria-label={`Get a copy of ${track.name}`}
        title={requested ? 'Queued — it will appear once it lands' : 'Not in the library yet — get it'}
        onClick={() => {
          setRequested(true);
          post('/api/tracks/want', {
            artist: (track.artists ?? track.artist_name ?? '').split(',')[0]?.trim() ?? '',
            title: track.name,
            album: track.album ?? null,
            durationMs: track.duration_ms ?? null,
          })
            .then((d) => player.notify((d as { detail?: string }).detail ?? 'Queued'))
            .catch((e: Error) => { player.notify(e.message, true); setRequested(false); });
        }}
      >
        {DOWNLOAD_ICON}
      </button>
    );
  }

  return (
    <button
      className={`track-play${state}`} type="button" data-track-id={track.id}
      aria-label={`Play ${track.name}`} onClick={() => play(track)}
    >
      {PLAY_ICON}
    </button>
  );
}

/** "More like this one." Only library tracks have a recording id to seed with. */
export function RadioControl({ track }: { track: Track }) {
  if (!/^libtrack-/.test(String(track.id))) return null;
  return (
    <Link className="track-radio" to={`/radio/track/${encodeURIComponent(track.id)}`} aria-label={`Radio from ${track.name}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="14" r="2.6" /><path d="M6.1 8.6a8.4 8.4 0 0 1 11.8 0M8.9 11.4a4.5 4.5 0 0 1 6.2 0" />
      </svg>
    </Link>
  );
}

export const SpotifyLink = ({ type, id }: { type: string; id: string }) => (
  <a className="ext" href={`https://open.spotify.com/${type}/${id}`} target="_blank" rel="noopener" title="open in Spotify">↗</a>
);

export const SpotifyButton = ({ type, id }: { type: string; id: string }) => (
  <a className="spbtn" href={`https://open.spotify.com/${type}/${id}`} target="_blank" rel="noopener">Open in Spotify ↗</a>
);

/** Legal lossless: a Bandcamp search deep-link. */
export const BandcampButton = ({ query, type = 'a', label = 'Find on Bandcamp ↗' }: {
  query: string; type?: string; label?: string;
}) => (
  <a className="spbtn" href={`https://bandcamp.com/search?q=${encodeURIComponent(query)}&item_type=${type}`} target="_blank" rel="noopener">{label}</a>
);

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

/** Shown only when a view takes noticeably long, so cached views never flash. */
export function Skeleton() {
  return (
    <div className="skeleton">
      {Array.from({ length: 9 }, (_, i) => (
        <div className="skeleton-row" key={i}><span /><span /></div>
      ))}
    </div>
  );
}
