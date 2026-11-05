import { LikeButton } from './LikeButton.tsx';
import { Link } from 'react-router-dom';

import { bareAlbumName, dur, shortDay } from '../lib/format.ts';
import type { Album, GigEvent, Track } from '../api/types.ts';
import { Badges, MediaBadges, Pic, PlayControl, RadioControl, SpotifyLink, useArchiveState, useNowPlaying } from './primitives.tsx';

const DownloadBadge = () => (
  <span className="dl" title="This album is in your archive">
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
    <span>In archive</span>
  </span>
);

/**
 * A song's state, in words, on a line of its own so it is never the part that
 * gets cut off. `removed` names what removed_at means where the row is shown:
 * un-liked on a liked list, taken out on a playlist.
 */
function RowStatus({ track, archive, removed }: { track: Track; archive: 'held' | 'missing' | 'ready' | 'playing'; removed: string }) {
  const parts = [
    track.removed_at ? `${removed} ${shortDay(track.removed_at)}` : '',
    archive === 'missing' ? 'Not in your archive' : archive === 'ready' ? 'Ready to play' : '',
  ].filter(Boolean);
  return parts.length ? <div className="row-status">{parts.join(' · ')}</div> : null;
}

export function TrackRow({ track, endText, rank, removed = 'Removed on Spotify' }: {
  track: Track; endText?: string | undefined; rank?: number | null | undefined; removed?: string | undefined;
}) {
  const state = useNowPlaying(track.id);
  const archive = useArchiveState(track);
  const albumHref = track.album_id ? `/album/${track.album_id}` : null;
  return (
    <div className={`row${track.removed_at ? ' gone' : ''}${state}`} data-track-id={track.id}>
      {rank != null ? <span className="rank">{rank}</span> : null}
      <PlayControl track={track} />
      {albumHref
        ? <Link to={albumHref} tabIndex={-1} aria-hidden="true"><Pic kind="albums" id={track.album_id} cdn={track.image_url} name={track.album ?? track.name} /></Link>
        : <Pic kind="albums" id={track.album_id} cdn={track.image_url} name={track.album ?? track.name} />}
      <div className="mid">
        <div>{track.name}</div>
        <div className="sub">
          {track.artists ?? ''}
          {track.artists && track.album ? ' · ' : ''}
          {track.album ? (albumHref ? <Link to={albumHref}>{track.album}</Link> : track.album) : null}
        </div>
        <RowStatus track={track} archive={state ? 'playing' : archive} removed={removed} />
      </div>
      <MediaBadges row={track} />
      <RadioControl track={track} />
      <LikeButton track={track} />
      <div className="end">{endText ?? dur(track.duration_ms)}</div>
      {track.id && !track.id.startsWith('lib') ? <SpotifyLink type="track" id={track.id} /> : null}
    </div>
  );
}

/** Denser than a full row, so two fit side by side at desktop width. */
export function SongCard({ track, meta, current = true }: { track: Track; meta?: string | undefined; current?: boolean | undefined }) {
  const playing = useNowPlaying(track.id);
  const archive = useArchiveState(track);
  const state = current ? playing : '';
  const albumHref = track.album_id ? `/album/${track.album_id}` : null;
  return (
    <div className={`song-card${track.removed_at ? ' gone' : ''}${state}`} data-track-id={track.id}>
      <PlayControl track={track} current={current} />
      {albumHref
        ? <Link to={albumHref} tabIndex={-1} aria-hidden="true"><Pic kind="albums" id={track.album_id} cdn={track.image_url} name={track.album ?? track.name} /></Link>
        : <Pic kind="albums" id={track.album_id} cdn={track.image_url} name={track.album ?? track.name} />}
      <div className="song-main">
        <b>{track.name}</b>
        <span className="song-sub">
          {track.artists ?? track.artist_name ?? ''}
          {(track.artists ?? track.artist_name) && track.album ? ' · ' : ''}
          {track.album ? (albumHref ? <Link to={albumHref}>{track.album}</Link> : track.album) : null}
        </span>
        {/* The state leads the last line, so a date is what gives way, not it. */}
        {meta || (archive !== 'held' && !playing) ? (
          <span className="song-album">
            {archive !== 'held' && !playing ? <span className="not-held">{archive === 'ready' ? 'Ready to play' : 'Not in your archive'}</span> : null}
            {archive !== 'held' && !playing && meta ? ' · ' : ''}
            {meta ? <span className="song-meta">{meta}</span> : null}
          </span>
        ) : null}
      </div>
      <MediaBadges row={track} />
      <RadioControl track={track} />
      <LikeButton track={track} />
      <span className="song-dur">{dur(track.duration_ms)}</span>
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
  const editions = album.editions?.length ? `${album.editions.length + 1} editions` : '';
  const line = [year, type, editions, album.is_saved ? 'saved' : ''].filter(Boolean).join(' · ');

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
      {href ? <Link className="al-art" to={href} tabIndex={-1} aria-hidden="true">{art}</Link> : <span className="al-art">{art}</span>}
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
  // The leaf already gives the date and the badge the countdown; the foot
  // adds the weekday and, when one is announced, the time.
  const timed = when && (when.getHours() || when.getMinutes());
  const dateLine = when
    ? when.toLocaleString(undefined, { weekday: 'long', ...(timed ? { hour: '2-digit', minute: '2-digit' } : {}) })
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
