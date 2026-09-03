import { Link } from 'react-router-dom';

import { bareAlbumName, day, dur } from '../lib/format.ts';
import type { Album, GigEvent, Track } from '../api/types.ts';
import { usePlayer } from '../player/usePlayer.ts';
import { Badges, MediaBadges, Pic, PlayControl, RadioControl, SpotifyLink } from './primitives.tsx';

const DownloadBadge = () => (
  <span className="dl" title="already in the local library">
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">
      <path fill="currentColor" d="M11 3h2v8h3l-4 4-4-4h3z" /><path fill="currentColor" d="M5 19h14v2H5z" />
    </svg>
  </span>
);

/**
 * Which row is playing, marked from player state rather than by re-rendering.
 *
 * One track can be visible on several surfaces at once, and the player outlives
 * navigation -- so the marker is derived from the engine's snapshot, and only
 * the rows for that id re-render.
 */
function useNowPlaying(id: string): '' | ' playing' | ' paused' {
  const p = usePlayer();
  if (p.currentId !== id) return '';
  return p.state === 'playing' ? ' playing' : ' paused';
}

export function TrackRow({ track, endText, rank }: { track: Track; endText?: string | undefined; rank?: number | null | undefined }) {
  const state = useNowPlaying(track.id);
  const albumHref = track.album_id ? `/album/${track.album_id}` : null;
  return (
    <div className={`row${track.removed_at ? ' gone' : ''}${state}`} data-track-id={track.id}>
      {rank != null ? <span className="rank">{rank}</span> : null}
      <PlayControl track={track} />
      {albumHref
        ? <Link to={albumHref}><Pic kind="albums" id={track.album_id} cdn={track.image_url} name={track.album ?? track.name} /></Link>
        : <Pic kind="albums" id={track.album_id} cdn={track.image_url} name={track.album ?? track.name} />}
      <div className="mid">
        <div>{track.name} {track.removed_at ? <span className="chip bad">{`removed ${day(track.removed_at)}`}</span> : null}</div>
        <div className="sub">
          {track.artists ?? ''}
          {track.album ? <> · {albumHref ? <Link to={albumHref}>{track.album}</Link> : track.album}</> : null}
        </div>
      </div>
      <MediaBadges row={track} />
      <div className="end">{endText ?? dur(track.duration_ms)}</div>
      <RadioControl track={track} />
      {track.id && !track.id.startsWith('lib') ? <SpotifyLink type="track" id={track.id} /> : null}
    </div>
  );
}

/** Denser than a full row, so two fit side by side at desktop width. */
export function SongCard({ track, meta }: { track: Track; meta?: string | undefined }) {
  const state = useNowPlaying(track.id);
  const albumHref = track.album_id ? `/album/${track.album_id}` : null;
  return (
    <div className={`song-card${track.removed_at ? ' gone' : ''}${state}`} data-track-id={track.id}>
      <PlayControl track={track} />
      {albumHref
        ? <Link to={albumHref}><Pic kind="albums" id={track.album_id} cdn={track.image_url} name={track.album ?? track.name} /></Link>
        : <Pic kind="albums" id={track.album_id} cdn={track.image_url} name={track.album ?? track.name} />}
      <div className="song-main">
        <b>{track.name}</b>
        <span className="song-sub">{track.artists ?? track.artist_name ?? ''}</span>
        {track.album ? (
          <span className="song-album">{albumHref ? <Link to={albumHref}>{track.album}</Link> : track.album}</span>
        ) : null}
      </div>
      <MediaBadges row={track} />
      <div className="song-end">
        <span className="song-dur">{dur(track.duration_ms)}</span>
        {meta ? <small>{meta}</small> : null}
      </div>
    </div>
  );
}

/**
 * THE standard album card. Everything album-shaped renders through this, so
 * the library reads the same wherever an album appears.
 */
export function AlbumCell({ album, when, extraClass }: { album: Album; when?: string | undefined; extraClass?: string | undefined }) {
  const id = album.id ?? album.album_id;
  const href = id ? `/album/${id}` : null;
  const name = bareAlbumName(album.name);
  const year = (album.release_date ?? '').slice(0, 4)
    || (String(album.name).match(/\((\d{4})\)/) ?? [])[1] || '';
  const type = (album.album_group && album.album_group !== 'album') ? album.album_group
    : (album.album_type === 'single' || album.kind === 'single') ? 'single' : '';
  const line = [year, type, album.is_saved ? 'saved ✓' : ''].filter(Boolean).join(' · ');

  const art = (
    <Pic
      kind="albums" id={id} cdn={album.image_url} name={name}
      overlay={<>
        {album.downloaded ? <DownloadBadge /> : null}
        {when ? <span className="al-when">{when}</span> : null}
      </>}
    />
  );

  return (
    <div className={`al-card${extraClass ? ` ${extraClass}` : ''}`}>
      {href ? <Link className="al-art" to={href}>{art}</Link> : <span className="al-art">{art}</span>}
      <div className="al-body">
        <b>{href ? <Link to={href}>{name}</Link> : name}</b>
        <span className="sub">{album.artists ?? ''}</span>
        {line ? <span className="sub dim">{line}</span> : null}
        <Badges row={album} />
        <MediaBadges row={album} />
      </div>
    </div>
  );
}

export function GigCard({ event, index = 0 }: { event: GigEvent; index?: number | undefined }) {
  const when = event.datetime ? new Date(event.datetime) : null;
  const days = when ? Math.ceil((when.getTime() - Date.now()) / 864e5) : null;
  const soon = days != null && days >= 0 && days <= 14;
  const countdown = days == null ? '' : days <= 0 ? 'tonight' : days === 1 ? 'tomorrow' : `in ${days} days`;
  const dateLine = when
    ? when.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : 'date TBA';
  const showTitle = event.name && (event.name ?? '').toLowerCase() !== (event.artist_name ?? '').toLowerCase()
    ? event.name : '';

  const art = (
    <>
      <Pic kind="artists" id={event.artist_id} cdn={event.image_url} name={event.artist_name} />
      <span className="gig-leaf">
        <b>{when ? when.getDate() : '·'}</b>
        <i>{when ? when.toLocaleDateString(undefined, { month: 'short' }) : 'TBA'}</i>
      </span>
      {countdown ? <span className={`gig-soon${soon ? ' hot' : ''}`}>{countdown}</span> : null}
    </>
  );

  return (
    <div className="gig-card" style={{ '--i': Math.min(index, 17) } as React.CSSProperties}>
      {event.artist_id
        ? <Link className="gig-art" to={`/artist/${event.artist_id}`}>{art}</Link>
        : <div className="gig-art">{art}</div>}
      <div className="gig-body">
        <b>{event.artist_id ? <Link to={`/artist/${event.artist_id}`}>{event.artist_name}</Link> : event.artist_name}</b>
        {showTitle ? <span className="gig-title">{showTitle}</span> : null}
        <span className="gig-where">
          {event.venue ?? ''}{event.venue && event.city ? ' · ' : ''}{event.city ?? ''}
          {event.country ? ` (${event.country})` : ''}
        </span>
        <div className="gig-foot">
          <span>{dateLine}</span>
          {event.url ? <a className="gig-tickets" href={event.url} target="_blank" rel="noopener">Tickets ↗</a> : null}
        </div>
      </div>
    </div>
  );
}
