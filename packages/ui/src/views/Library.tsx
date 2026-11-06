import { Fragment, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  useArtists, useLatest, useLibraryAlbums, useLikedTracks,
  usePlaylists, usePlaylistTracks, usePlays, useSavedAlbums,
} from '../api/hooks.ts';
import { get, post, qs } from '../api/client.ts';
import { ago, day, dur, initial, shortDay } from '../lib/format.ts';
import { useDebounced } from '../lib/useDebounced.ts';
import { AlbumCell, TrackHeader, TrackRow } from '../components/rows.tsx';
import { Badges, Empty, GenreChips, PLAY_ICON, Pic, Skeleton } from '../components/primitives.tsx';
import { PlayScope, usePlayAll } from '../components/PlayScope.tsx';
import type { Track } from '../api/types.ts';

export function Artists() {
  const { data, isPending, error } = useArtists();
  const [followedOnly, setFollowedOnly] = useState(false);
  if (isPending) return <Skeleton />;
  if (error) return <Empty>{error.message}</Empty>;
  const all = data ?? [];
  // A heart pressed here counts the same as a Spotify follow.
  const rows = all.filter((a) => !followedOnly || (a.liked ?? a.is_followed));

  return (
    <>
      <div className="tools">
        <div className="seg">
          <button type="button" className={followedOnly ? undefined : 'on'} aria-pressed={!followedOnly} onClick={() => setFollowedOnly(false)}>All artists</button>
          <button type="button" className={followedOnly ? 'on' : undefined} aria-pressed={followedOnly} onClick={() => setFollowedOnly(true)}>Followed</button>
        </div>
      </div>
      <div className="grid">
        {rows.length ? rows.map((a) => (
          <div className="cell" key={a.id}>
            <Link to={`/artist/${a.id}`}>
              <Pic kind="artists" id={a.id} cdn={a.image_url} name={a.name} />
              <div className="nm">{a.name}</div>
            </Link>
            <div className="sub">
              {[
                (a.liked ?? a.is_followed) ? 'Followed' : '',
                a.liked_count ? `${a.liked_count} liked` : '',
                a.top_rank ? `top #${a.top_rank}` : '',
              ].filter(Boolean).join('\u00a0· ')}
            </div>
            <GenreChips json={a.genres} />
            <Badges row={a} />
          </div>
        )) : <Empty>no matches</Empty>}
      </div>
    </>
  );
}

export function Songs() {
  const { data, isPending, error } = useLikedTracks();
  if (isPending) return <Skeleton />;
  if (error) return <Empty>{error.message}</Empty>;
  // A song liked here and on Spotify is one song, listed once.
  const rows = [...new Map((data ?? []).filter(t => !t.removed_at).map(t => [t.id, t])).values()];
  return <>
    <h2>All liked songs <span className="count">{rows.length.toLocaleString()}</span></h2>
    {rows.length ? <PlayScope tracks={rows}><div className="rows liked-page">
      <TrackHeader date="Liked" />
      {rows.map(t => <TrackRow key={t.id} track={t} date={day(t.added_at)} />)}
    </div></PlayScope> : <Empty>Like a song to save it here alongside your Spotify likes.</Empty>}
  </>;
}

export function Albums() {
  const saved = useSavedAlbums();
  const library = useLibraryAlbums();
  if (saved.isPending && library.isPending) return <Skeleton />;
  const savedRows = saved.data ?? [];
  const libRows = library.data ?? [];

  return (
    <>
      {savedRows.length ? (
        <>
          <h2>Saved <span className="count">{savedRows.length}</span></h2>
          <div className="al-grid">{savedRows.map((a) => <AlbumCell key={a.id ?? a.name} album={a} />)}</div>
        </>
      ) : null}
      <h2>In the library <small>{libRows.length ? `(${libRows.length})` : ''}</small></h2>
      <div className="al-grid">
        {libRows.length
          ? libRows.slice(0, 600).map((a) => <AlbumCell key={a.id ?? a.album_id ?? a.name} album={a} />)
          : <Empty>no matches on disk</Empty>}
      </div>
    </>
  );
}

export function Playlists() {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  async function create() {
    setSaving(true);
    try {
      const result = await post<{ id: string }>('/api/local-playlists', { name, trackIds: [] });
      await cache.invalidateQueries({ queryKey: ['playlists'] });
      navigate(`/playlist/${result.id}`);
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  }
  const { data, isPending, error } = usePlaylists();
  if (isPending) return <Skeleton />;
  if (error) return <Empty>{error.message}</Empty>;
  const all = data ?? [];
  // Spotify refuses to enumerate some playlists, so they sync with zero tracks.
  // A card that opens to an empty page is worse than no card.
  const pls = all.filter((p) => p.source === 'local' || Number(p.synced_tracks ?? 0) > 0);
  // Playlists gone from Spotify go last; they still play from the archive.
  pls.sort((x, y) => Number(Boolean(x.removed_at)) - Number(Boolean(y.removed_at)));
  const hidden = all.length - pls.length;

  return (
    <>
      <form className="tools" onSubmit={e => { e.preventDefault(); void create(); }}>
        <input aria-label="New playlist name" placeholder="New playlist name" value={name} onChange={e => setName(e.target.value)} required maxLength={200} />
        <button disabled={saving || !name.trim()}>Create playlist</button>
      </form>
      {message && <p role="alert">{message}</p>}
      {hidden ? <p className="note">{hidden} playlist{hidden === 1 ? '' : 's'} hidden — Spotify returned no tracks for {hidden === 1 ? 'it' : 'them'}.</p> : null}
      <div className="al-grid pl-grid">
        {pls.map((p) => {
          const art = (p.images ?? []).slice(0, 4);
          return (
            <div className={`al-card pl-card${p.removed_at ? ' gone' : ''}`} key={p.id}>
              <Link className="al-art" to={`/playlist/${p.id}`} tabIndex={-1} aria-hidden="true">
                {art.length ? (
                  <span className={`pl-collage n${art.length}`}>
                    {art.map((u, i) => <img key={i} src={u} alt="" loading="lazy" />)}
                  </span>
                ) : (
                  <span className="pl-collage empty-collage"><span className="ph">{initial(p.name)}</span></span>
                )}
              </Link>
              <div className="al-body">
                <b><Link to={`/playlist/${p.id}`}>{p.name}</Link></b>
                <span className="sub">{p.synced_tracks ?? p.total_tracks ?? 0} songs · {p.source === 'local' ? 'made here' : 'from Spotify'}</span>
                {p.removed_at ? <span className="status">Gone from your Spotify {shortDay(p.removed_at)}</span>
                  : p.description ? <span className="sub dim">{p.description}</span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function PlaylistDetail() {
  const { id } = useParams();
  const playlists = usePlaylists();
  const tracks = usePlaylistTracks(id);
  const playAll = usePlayAll();
  if (tracks.isPending) return <Skeleton />;
  const rows = tracks.data ?? [];
  const meta = playlists.data?.find((p) => p.id === id);
  return (
    <>
      {meta ? (
        <div className="hero pl-hero">
          {(meta.images ?? []).length ? (
            <span className={`pl-collage n${Math.min(4, (meta.images ?? []).length)}`}>
              {(meta.images ?? []).slice(0, 4).map((u, i) => <img key={i} src={u} alt="" />)}
            </span>
          ) : (
            <span className="pl-collage empty-collage"><span className="ph">{initial(meta.name)}</span></span>
          )}
          <div className="pl-head">
          <h1>{meta.name}</h1>
          <div className="meta">
            {rows.length} songs{meta.owner_name ? ` · by ${meta.owner_name}` : ''}
            {meta.removed_at ? ` · removed ${day(meta.removed_at)}` : ''}
          </div>
          {meta.description ? <p className="pl-desc">{meta.description}</p> : null}
          {rows.length ? (
            <div className="hero-actions">
              <button className="primary-action play-album" type="button" onClick={() => playAll(rows)}>
                {PLAY_ICON} Play playlist
              </button>
            </div>
          ) : null}
          </div>
        </div>
      ) : null}
      {meta?.source === 'local' && id ? <PlaylistEditor id={id} name={meta.name} description={meta.description ?? ''} tracks={rows} /> : null}
      <PlayScope tracks={rows}>
        <div className="rows">
          {rows.length ? <TrackHeader rank date="Added" /> : null}
          {rows.length ? rows.map((t) => (
            <TrackRow key={`${t.id}-${t.position ?? 0}`} track={t} rank={t.position} removed="Taken off this playlist" date={day(t.added_at)} />
          )) : <Empty>empty (or blocked by the API)</Empty>}
        </div>
      </PlayScope>
    </>
  );
}

export function Latest() {
  const { data, isPending, error } = useLatest();
  if (isPending) return <Skeleton />;
  if (error) return <Empty>{error.message}</Empty>;
  const rows = data ?? [];
  if (!rows.length) return <Empty>nothing downloaded yet — or the archive is asleep</Empty>;

  // playable === false means the files are on disk but not indexed yet: show
  // the card dimmed and say so, rather than letting a finished-looking card
  // fail on play. null means the index is unavailable, which is unknown.
  const pending = rows.filter((r) => r.playable === false).length;
  const dayAgo = Date.now() - 864e5;
  const today = rows.filter((r) => r.added_at && Date.parse(r.added_at) >= dayAgo).length;
  const scope = today >= rows.length
    ? `All ${rows.length} arrived in the last 24 hours.`
    : today === 0
      ? `Nothing new today. These are the ${rows.length} most recent downloads.`
      : `${today} new today, and the ${rows.length - today} before them.`;

  return (
    <>
      <p className="note">
        {scope} Ordered by when the files landed.
        {pending ? ` ${pending} still syncing into the player — they go live within a few minutes.` : ''}
      </p>
      <div className="al-grid">
        {rows.map((row, i) => (
          <AlbumCell
            key={`${row.id ?? row.album_id ?? row.name}-${i}`} album={row}
            when={row.added_at ? (row.playable === false ? `syncing · ${ago(row.added_at)}` : ago(row.added_at)) : undefined}
            extraClass={row.playable === false ? 'pending' : undefined}
          />
        ))}
      </div>
    </>
  );
}

export function Plays() {
  const { data, isPending } = usePlays();
  if (isPending) return <Skeleton />;
  const all = data ?? [];
  if (!all.length) return <Empty>no plays captured yet</Empty>;
  const here = all.filter((p) => p.source === 'app').length;
  return (
    <>
      <p className="note">{all.length.toLocaleString()} recent plays, {here.toLocaleString()} of them played here</p>
      <PlayScope tracks={all}>
        {/* History reads top to bottom, so one column; only the newest play of
            the current song is marked as playing. */}
        <div className="rows history">
          <TrackHeader date="Played" quality={false} length={false} />
          {/* Grouped by day, with the clock time on each row, so a history
              reads in order instead of as a column of "25d ago". */}
          {all.map((p, i) => {
            const dayLabel = playDay(p.played_at);
            const first = i === 0 || playDay(all[i - 1]!.played_at) !== dayLabel;
            return (
              <Fragment key={`${p.id}-${i}`}>
                {first ? <div className="day-head">{dayLabel}</div> : null}
                <TrackRow track={p} current={all.findIndex((x) => x.id === p.id) === i}
                  date={clock(p.played_at)} note={p.source === 'app' ? 'On this player' : undefined} endText="" />
              </Fragment>
            );
          })}
        </div>
      </PlayScope>
    </>
  );
}

function PlaylistEditor({ id, name, description, tracks }: { id: string; name: string; description: string; tracks: Track[] }) {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState(name);
  const [notes, setNotes] = useState(description);
  const [q, setQ] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const search = useDebounced(q, 300);
  const results = useQuery({ queryKey: ['playlist-search', search], queryFn: () => get<Track[]>(`/api/search-songs${qs({ q: search })}`), enabled: search.trim().length >= 2 });
  async function save(next: Track[], remove = false) {
    setSaving(true); setMessage('');
    try {
      await post('/api/local-playlists', { id, name: title, description: notes, trackIds: next.map(t => t.id), action: remove ? 'delete' : 'save' });
      await Promise.all([cache.invalidateQueries({ queryKey: ['playlists'] }), cache.invalidateQueries({ queryKey: ['playlist-tracks', id] })]);
      if (remove) navigate('/playlists');
      else setMessage('Saved');
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  }
  function move(index: number, delta: number) {
    const next = [...tracks];
    const selected = next[index];
    const neighbor = next[index + delta];
    if (!selected || !neighbor) return;
    [next[index], next[index + delta]] = [neighbor, selected];
    void save(next);
  }
  return <details className="playlist-editor"><summary>Edit playlist</summary>
    <fieldset disabled={saving}>
      <label>Name <input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} /></label>
      <label>Description <input value={notes} onChange={e => setNotes(e.target.value)} maxLength={2000} /></label>
      <button onClick={() => void save(tracks)}>Save details</button>
      <button onClick={() => void save([], true)}>Delete playlist</button>
      <ol>{tracks.map((track, i) => <li key={`${track.id}-${i}`}>{track.name}
        <button aria-label={`Move ${track.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>Up</button>
        <button aria-label={`Move ${track.name} down`} disabled={i === tracks.length - 1} onClick={() => move(i, 1)}>Down</button>
        <button aria-label={`Remove ${track.name}`} onClick={() => void save(tracks.filter((_, index) => index !== i))}>Remove</button>
      </li>)}</ol>
      <label>Add songs <input type="search" placeholder="Search your library" value={q} onChange={e => setQ(e.target.value)} /></label>
      {results.error && <p role="alert">{results.error.message}</p>}
      {search.trim().length >= 2 && results.data?.map(track => <div key={track.id}>{track.name} ? {track.artists}
        <button onClick={() => void save([...tracks, track])}>Add</button></div>)}
    </fieldset>
    <p role="status">{message}</p>
  </details>;
}

/** "Today", "Yesterday", or "Mon 12 Oct" for a play's local day. */
function playDay(iso: string | null | undefined): string {
  if (!iso) return 'Undated';
  const when = new Date(iso);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(when)) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return when.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(when.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
}

/** "21:40" for a play. */
const clock = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
