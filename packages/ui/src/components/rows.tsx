import { LikeButton } from './LikeButton.tsx';
import { Link } from 'react-router-dom';

import { bareAlbumName, dur, shortDay } from '../lib/format.ts';
import type { Album, GigEvent, Track } from '../api/types.ts';
import { Badges, MediaBadges, Pic, PlayControl, RadioControl, RadioEnabled, SpotifyLink, useArchiveState, useNowPlaying } from './primitives.tsx';
import { use } from 'react';

/** Most of the shelf is in the archive, so the badge marks what is not. */
const MissingBadge = () => <span className="dl missing" title="No copy in your archive yet">Not in archive</span>;

/**
 * A song's state, in words, on a line of its own so it is never the part that
 * gets cut off. `removed` names what removed_at means where the row is shown:
 * un-liked on a liked list, taken out on a playlist.
 */
function RowStatus({ track, archive, removed, note }: {
  track: Track; archive: string; removed: string; note?: string | undefined;
}) {
  const parts = [track.removed_at ? `${removed} ${shortDay(track.removed_at)}` : '', archive, note ?? ''].filter(Boolean);
  return parts.length ? <span className="row-status">{parts.join(' · ')}</span> : null;
}

/**
 * THE song row. Every song list renders through this, in the same slots:
 * rank, play, art, title over artist and album with any status after it,
 * then quality, radio, the date column, heart and length.
 * `date` is already-formatted text for the date column; `note` joins the
 * status; `current` says whether this row is the one playing, for a
 * history that can list the same song twice.
 */
export function TrackRow({ track, endText, rank, date, note, current = true, removed = 'Removed on Spotify' }: {
  track: Track; endText?: string | undefined; rank?: number | null | undefined; date?: string | undefined;
  note?: string | undefined; current?: boolean | undefined; removed?: string | undefined;
}) {
  const playing = useNowPlaying(track.id);
  const state = current ? playing : '';
  const archive = useArchiveState(track);
  const albumHref = track.album_id ? `/album/${track.album_id}` : null;
  return (
    <div className={`row${track.removed_at ? ' gone' : ''}${state}`} data-track-id={track.id}>
      {rank != null ? <span className="rank">{rank}</span> : null}
      <PlayControl track={track} current={current} />
      {albumHref
        ? <Link to={albumHref} tabIndex={-1} aria-hidden="true"><Pic kind="albums" id={track.album_id} cdn={track.image_url} name={track.album ?? track.name} /></Link>
        : <Pic kind="albums" id={track.album_id} cdn={track.image_url} name={track.album ?? track.name} />}
      <div className="mid">
        <div>{track.name}</div>
        <div className="sub sub-line">
          <span className="sub-text">
            {track.artists ?? ''}
            {track.artists && track.album ? ' · ' : ''}
            {track.album ? (albumHref ? <Link to={albumHref}>{track.album}</Link> : track.album) : null}
          </span>
          <RowStatus track={track} archive={playing ? '' : archive.label} removed={removed} note={note} />
        </div>
      </div>
      <MediaBadges row={track} />
      <RadioControl track={track} />
      {date !== undefined ? <div className="row-date">{date}</div> : null}
      <LikeButton track={track} />
      <div className="end">{endText ?? dur(track.duration_ms)}</div>
      {track.id && !track.id.startsWith('lib') ? <SpotifyLink type="track" id={track.id} /> : null}
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
        {album.downloaded === 0 || album.downloaded === false ? <MissingBadge /> : null}
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
        <Badges row={album} compact />
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
    ? when.toLocaleString('en-GB', { weekday: 'long', ...(timed ? { hour: 'numeric', minute: '2-digit' } : {}) })
    : 'date TBA';
  // An event name that only repeats the artist adds nothing under the artist.
  const showTitle = event.name && !(event.name ?? '').toLowerCase().startsWith((event.artist_name ?? '').toLowerCase())
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

/** Column names over a song list, so a date says what it is. Desktop only. */
export function TrackHeader({ rank, date, art = true, quality = true, length = true }: {
  rank?: boolean | undefined; date?: string | undefined; art?: boolean | undefined; quality?: boolean | undefined; length?: boolean | undefined;
}) {
  const radio = use(RadioEnabled);
  return (
    <div className="row row-head" aria-hidden="true">
      {rank ? <span className="rank">#</span> : null}
      <span className="head-lead" />
      {art ? <span className="head-art" /> : null}
      <div className="mid">Title</div>
      {quality ? <span className="head-badges">Quality</span> : null}
      {radio ? <span className="head-radio" /> : null}
      {date ? <div className="row-date">{date}</div> : null}
      <span className="head-like" />
      {length ? <div className="end">Length</div> : null}
    </div>
  );
}
