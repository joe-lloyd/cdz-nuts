import { createContext, use, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { artUrl, genres as parseGenres, cardDay, initial, shortDay } from '../lib/format.ts';
import type { Badged, QualityTier, Tombstoned, Track } from '../api/types.ts';
import { post } from '../api/client.ts';
import { player, usePlayer } from '../player/usePlayer.ts';
import { useDownloadProgress, downloadLabel } from './DownloadProgress.tsx';
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

/** A scanner badge or a confirmed playable installation is sufficient. */
export const isHeld = (track: Badged): boolean => Boolean(track.quality || track.playable);

/**
 * Where a song stands against the archive. Known from the list's own data,
 * so a row that needs a status line has it from the first paint; the
 * download check can only turn "missing" into "ready", never add a line.
 */
export function useArchiveState(track: Track): { state: 'held' | 'missing' | 'ready'; label: string } {
  const held = isHeld(track);
  const progress = useDownloadProgress(track, held);
  if (held) return { state: 'held', label: '' };
  if (progress.status?.ready) return { state: 'ready', label: '' };
  // A download under way says how far it has got; otherwise, plainly, missing.
  return { state: 'missing', label: downloadLabel(progress.status) ?? 'Not in archive' };
}

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
    <div className={`pic pic-${kind}`}>
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

export const Chip = ({ text }: { text: string }) => <span className="chip">{text}</span>;

/** A state, not a tag: a dot and words, so it never reads as a genre. */
export const Status = ({ text, title }: { text: string; title?: string | undefined }) => (
  <span className="status" title={title}>{text.replace(/(\d+) (\w+) (\d{4})/, '$1\u00a0$2\u00a0$3')}</span>
);

export const Chips = ({ children }: { children: ReactNode[] }) => {
  const kept = children.filter(Boolean);
  return kept.length ? <div className="chips">{kept}</div> : null;
};

export const GenreChips = ({ json, n = 3 }: { json?: string | null | undefined; n?: number | undefined }) => {
  const list = parseGenres(json, n);
  return list.length ? <div className="chips">{list.map((g) => <Chip key={g} text={g} />)}</div> : null;
};

/**
 * Tombstones: history is kept, these say what changed and when. A card is
 * narrow, so there each one keeps to a line and the full words are a tooltip.
 */
export function Badges({ row, compact = false }: { row: Tombstoned; compact?: boolean | undefined }) {
  // Spotify pulled it from its catalogue; the archive keeps what it had.
  const removed = row.removed_at ? `No longer on Spotify · ${shortDay(row.removed_at)}` : '';
  const items = [
    row.removed_at ? <Status key="r" text={compact ? `Off Spotify · ${cardDay(row.removed_at)}` : removed} title={compact ? removed : undefined} /> : null,
    row.unfollowed_at && !row.is_followed ? <Status key="u" text={`Unfollowed ${shortDay(row.unfollowed_at)}`} /> : null,
    row.unsaved_at && !row.is_saved ? <Status key="s" text={`Unsaved ${shortDay(row.unsaved_at)}`} /> : null,
  ].filter(Boolean);
  return items.length ? <div className="statuses">{items}</div> : null;
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
/** "320k" reads as a bitrate once it says its unit; FLAC and 24/96 already do. */
export const readableQuality = (label: string): string => {
  const kbps = /^(\d+)k$/.exec(label);
  return kbps ? `${kbps[1]} kbps` : label;
};

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
          {row.quality_label ? <b>{readableQuality(row.quality_label)}</b> : null}
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

/** A request already made: a clock, not another arrow to press. */
const WAITING_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm-1 2v6l5 3 1-1.6-4-2.4V7z" />
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
export function PlayControl({ track, current = true, words = false }: {
  track: Track; current?: boolean | undefined;
  /** The request as a labelled button for a row's status line, and nothing for a song you hold. */
  words?: boolean | undefined;
}) {
  const play = usePlayFromScope();
  // A history can list the playing song twice; only the row that is current shows it.
  const playing = useNowPlaying(track.id);
  const state = current ? playing : '';
  const [requested, setRequested] = useState(false);
  const progress = useDownloadProgress(track, isHeld(track));
  const label = downloadLabel(progress.status) ?? (requested ? 'Waiting for download…' : null);
  const stopped = progress.status && ['exhausted', 'cancelled'].includes(progress.status.status);
  const busy = !stopped && (requested || Boolean(label));
  if (!track.id) return null;

  const request = () => {
    if (progress.failed) { progress.refresh?.(); return; }
    setRequested(true);
    post('/api/tracks/want', {
      artist: (track.artists ?? track.artist_name ?? '').split(',')[0]?.trim() ?? '',
      title: track.name,
      album: track.album ?? null,
      durationMs: track.duration_ms ?? null,
      recordingMbid: track.recording_mbid ?? null,
      releaseMbid: track.release_mbid ?? null,
    })
      .then((d) => { player.notify((d as { detail?: string }).detail ?? 'Queued'); progress.refresh?.(); })
      .catch((e: Error) => { player.notify(e.message, true); setRequested(false); });
  };
  const missing = !isHeld(track) && !progress.status?.ready && !state;

  if (words) {
    if (!missing) return null;
    // The status line already says how a download is going; until the
    // first check answers, it says the request went in.
    if (busy && !progress.failed) return downloadLabel(progress.status) ? null : <span className="row-action-note">Requested</span>;
    return (
      <button className="row-action" type="button" aria-label={`Request a download of ${track.name}`} onClick={request}>
        {progress.failed ? 'Check again' : stopped ? 'Request again'
          : <><span className="ra-long">Request download</span><span className="ra-short">Request</span></>}
      </button>
    );
  }

  if (missing) {
    return (
      <span className="download-control">
      <button
        className={`radio-get${busy ? ' queued' : ''}`} type="button" disabled={busy && !progress.failed}
        aria-label={`Get a copy of ${track.name}`}
        title={progress.failed ? 'Check download progress again' : progress.status?.error ?? label ?? 'Request a download into your archive'}
        onClick={request}
      >
        {busy ? WAITING_ICON : <span className="get-word" aria-hidden="true">Get</span>}
      </button>
      {progress.failed || label ? <span className="download-status" role="status">{progress.failed ? 'Progress unavailable · retry' : label}</span> : null}
      </span>
    );
  }

  return (
    <button
      className={`track-play${state}`} type="button" data-track-id={track.id}
      aria-label={`Play ${track.name}`} title={progress.status?.ready ? 'Ready to play' : undefined} onClick={() => play(track)}
    >
      {PLAY_ICON}
    </button>
  );
}

/** Every song can seed radio; catalog metadata lets the server find its recording. */
/**
 * Whether radio can run. Radio needs ListenBrainz, and with it off a radio
 * link would only lead to the page saying so. The shell provides the answer;
 * anything rendered outside it assumes radio works.
 */
export const RadioEnabled = createContext(true);

export function RadioControl({ track }: { track: Track }) {
  const enabled = use(RadioEnabled);
  if (!track.id || !enabled) return null;
  const seed = new URLSearchParams({ artist: track.artists ?? track.artist_name ?? '', title: track.name });
  if (track.recording_mbid) seed.set('mbid', track.recording_mbid);
  return (
    <Link className="track-radio" to={`/radio/track/${encodeURIComponent(track.id)}?${seed}`} title={`Radio from ${track.name}`} aria-label={`Radio from ${track.name}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="14" r="2.6" /><path d="M6.1 8.6a8.4 8.4 0 0 1 11.8 0M8.9 11.4a4.5 4.5 0 0 1 6.2 0" />
      </svg>
      <span>Radio</span>
    </Link>
  );
}

export const SpotifyLink = ({ type, id }: { type: string; id: string }) => (
  <a className="ext" href={`https://open.spotify.com/${type}/${id}`} target="_blank" rel="noopener" title="Open in Spotify" aria-label="Open in Spotify">↗</a>
);

export const SpotifyButton = ({ type, id }: { type: string; id: string }) => (
  <a className="spbtn" href={`https://open.spotify.com/${type}/${id}`} target="_blank" rel="noopener">Spotify ↗</a>
);

/** Legal lossless: a Bandcamp search deep-link. */
export const BandcampButton = ({ query, type = 'a', label = 'Bandcamp ↗' }: {
  query: string; type?: string; label?: string;
}) => (
  <a className="spbtn" href={`https://bandcamp.com/search?q=${encodeURIComponent(query)}&item_type=${type}`} target="_blank" rel="noopener">{label}</a>
);

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

/**
 * A page with nothing to show yet: what it means in plain words, what to do,
 * and any technical steps folded away for whoever runs the server.
 */
export function Notice({ title, children, actions, details }: {
  title: string; children?: ReactNode; actions?: ReactNode; details?: ReactNode;
}) {
  return (
    <section className="notice">
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {actions ? <div className="notice-actions">{actions}</div> : null}
      {details ? <details className="notice-details"><summary>Setup details</summary>{details}</details> : null}
    </section>
  );
}

/**
 * Shown only when a view takes noticeably long, so cached views never flash.
 * It says what is coming, and a detail page keeps the shape of its header.
 */
export function Skeleton({ label = 'Loading…', hero = false, rows = 9 }: {
  label?: string | null | undefined; hero?: boolean | undefined; rows?: number | undefined;
}) {
  return (
    <div className="skeleton">
      {label ? <p className="skeleton-label" role="status">{label}</p> : null}
      {hero ? <div className="skeleton-hero"><span className="skeleton-art" /><div><span /><span /><span /></div></div> : null}
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}><span /><span /></div>
      ))}
    </div>
  );
}
