import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import {
  useArtists, useLatest, useLibraryAlbums, useLikedTracks, useLocalTracks,
  usePlaylists, usePlaylistTracks, usePlays, useSavedAlbums,
} from '../api/hooks.ts';
import { get, qs } from '../api/client.ts';
import { ago, day, dur, initial } from '../lib/format.ts';
import { useDebounced } from '../lib/useDebounced.ts';
import { AlbumCell, SongCard, TrackRow } from '../components/rows.tsx';
import { Badges, Empty, GenreChips, Pic, Skeleton } from '../components/primitives.tsx';
import { PlayScope } from '../components/PlayScope.tsx';
import type { Track } from '../api/types.ts';

export function Artists() {
  const { data, isPending, error } = useArtists();
  const [q, setQ] = useState('');
  const [followedOnly, setFollowedOnly] = useState(false);
  if (isPending) return <Skeleton />;
  if (error) return <Empty>{error.message}</Empty>;
  const all = data ?? [];
  const needle = q.toLowerCase();
  const rows = all.filter((a) =>
    (!followedOnly || a.is_followed)
    && (!needle || a.name.toLowerCase().includes(needle) || (a.genres ?? '').toLowerCase().includes(needle)));

  return (
    <>
      <div className="tools">
        <input type="search" placeholder={`search ${all.length} artists…`} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="chk">
          <input type="checkbox" checked={followedOnly} onChange={(e) => setFollowedOnly(e.target.checked)} /> followed only
        </label>
      </div>
      <div className="grid">
        {rows.length ? rows.map((a) => (
          <div className="cell" key={a.id}>
            <Link to={`/artist/${a.id}`}>
              <Pic kind="artists" id={a.id} cdn={a.image_url} name={a.name} />
              <div className="nm">{a.is_followed ? '★ ' : ''}{a.name}</div>
            </Link>
            <div className="sub">
              {a.liked_count ? `${a.liked_count} liked` : ''}
              {a.top_rank ? `${a.liked_count ? ' · ' : ''}#${a.top_rank}` : ''}
            </div>
            <Badges row={a} />
            <GenreChips json={a.genres} />
          </div>
        )) : <Empty>no matches</Empty>}
      </div>
    </>
  );
}

export function Songs() {
  const liked = useLikedTracks();
  const local = useLocalTracks();
  const [q, setQ] = useState('');
  const [showGone, setShowGone] = useState(false);
  const debounced = useDebounced(q, 300);

  // Liked songs are the page; the search box reaches the whole library.
  // Server-side, because "everything" is tens of thousands of tracks. Query's
  // keyed cache is what drops out-of-order responses — the old code needed a
  // hand-rolled generation counter for exactly this.
  const search = useQuery({
    queryKey: ['search-songs', debounced],
    queryFn: () => get<Track[]>(`/api/search-songs${qs({ q: debounced })}`),
    enabled: debounced.trim().length >= 2,
    staleTime: 60_000,
  });

  if (liked.isPending) return <Skeleton />;
  const all = liked.data ?? [];
  const needle = q.trim().toLowerCase();
  const matches = (t: Track) =>
    !needle || `${t.name} ${t.artists ?? ''} ${t.album ?? ''}`.toLowerCase().includes(needle);

  const rows = all.filter((t) => (showGone || !t.removed_at) && matches(t));
  const mine = (local.data ?? []).filter(matches);
  const likedIds = new Set(all.map((t) => t.id));
  const extra = (search.data ?? []).filter((t) => !likedIds.has(t.id));

  return (
    <>
      <div className="tools">
        <input type="search" placeholder="search liked songs, or the whole library…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="chk">
          <input type="checkbox" checked={showGone} onChange={(e) => setShowGone(e.target.checked)} /> show un-liked
        </label>
      </div>

      <h2>Liked songs ({rows.length.toLocaleString()})</h2>
      {rows.length ? (
        <PlayScope tracks={rows}>
          <div className="song-grid">
            {rows.map((t) => <SongCard key={t.id} track={t} meta={t.added_at ? day(t.added_at) : undefined} />)}
          </div>
        </PlayScope>
      ) : <Empty>no matches</Empty>}

      {debounced.trim().length >= 2 ? (
        <>
          <h2>Everywhere in the library {extra.length ? `(${extra.length}${(search.data?.length ?? 0) >= 150 ? '+' : ''})` : ''}</h2>
          {search.isPending ? <Empty>searching…</Empty>
            : extra.length ? (
              <PlayScope tracks={extra}>
                <div className="song-grid">
                  {extra.map((t) => <SongCard key={t.id} track={t} meta={t.liked ? 'liked' : undefined} />)}
                </div>
              </PlayScope>
            ) : <Empty>nothing else matches — every hit is already in your liked songs</Empty>}
        </>
      ) : null}

      {mine.length ? (
        <>
          <h2>Downloaded here ({mine.length.toLocaleString()})</h2>
          <PlayScope tracks={mine}>
            {mine.some((t) => t.standalone) ? (
              <div className="song-grid">
                {mine.filter((t) => t.standalone).map((t) => <SongCard key={t.id} track={t} meta="single" />)}
              </div>
            ) : null}
            {mine.some((t) => !t.standalone) ? (
              <>
                <h3 className="sub-head">From imported albums</h3>
                <div className="song-grid">
                  {mine.filter((t) => !t.standalone).map((t) => <SongCard key={t.id} track={t} meta={t.codec ?? undefined} />)}
                </div>
              </>
            ) : null}
          </PlayScope>
        </>
      ) : null}
    </>
  );
}

export function Albums() {
  const saved = useSavedAlbums();
  const library = useLibraryAlbums();
  const [q, setQ] = useState('');
  const needle = q.toLowerCase();
  const match = (name: string, artists?: string | null) =>
    !needle || `${name} ${artists ?? ''}`.toLowerCase().includes(needle);

  if (saved.isPending && library.isPending) return <Skeleton />;
  const savedRows = (saved.data ?? []).filter((a) => match(a.name, a.artists));
  const libRows = (library.data ?? []).filter((a) => match(a.name, a.artists));

  return (
    <>
      <div className="tools">
        <input type="search" placeholder="search albums…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {savedRows.length ? (
        <>
          <h2>Saved ({savedRows.length})</h2>
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
  const { data, isPending, error } = usePlaylists();
  if (isPending) return <Skeleton />;
  if (error) return <Empty>{error.message}</Empty>;
  const all = data ?? [];
  // Spotify refuses to enumerate some playlists, so they sync with zero tracks.
  // A card that opens to an empty page is worse than no card.
  const pls = all.filter((p) => Number(p.synced_tracks ?? 0) > 0);
  const hidden = all.length - pls.length;

  if (!pls.length) {
    return <Empty>no playlists with readable tracks yet{all.length ? ` — ${all.length} synced but returned no songs` : ''}</Empty>;
  }
  return (
    <>
      {hidden ? <p className="note">{hidden} playlist{hidden === 1 ? '' : 's'} hidden — Spotify returned no tracks for {hidden === 1 ? 'it' : 'them'}.</p> : null}
      <div className="al-grid pl-grid">
        {pls.map((p) => {
          const art = (p.images ?? []).slice(0, 4);
          return (
            <div className={`al-card pl-card${p.removed_at ? ' gone' : ''}`} key={p.id}>
              <Link className="al-art" to={`/playlist/${p.id}`}>
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
                <span className="sub">{p.synced_tracks ?? p.total_tracks ?? 0} songs{p.owner_name ? ` · ${p.owner_name}` : ''}</span>
                {p.removed_at ? <span className="sub dim">removed {day(p.removed_at)}</span>
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
  if (tracks.isPending) return <Skeleton />;
  const rows = tracks.data ?? [];
  const meta = playlists.data?.find((p) => p.id === id);
  return (
    <>
      {meta ? (
        <div className="pl-head">
          <h1>{meta.name}</h1>
          <div className="meta">
            {rows.length} songs{meta.owner_name ? ` · by ${meta.owner_name}` : ''}
            {meta.removed_at ? ` · removed ${day(meta.removed_at)}` : ''}
          </div>
          {meta.description ? <p className="note">{meta.description}</p> : null}
        </div>
      ) : null}
      <PlayScope tracks={rows}>
        <div className="rows">
          {rows.length ? rows.map((t) => (
            <TrackRow key={`${t.id}-${t.position ?? 0}`} track={t} rank={t.position}
              endText={`${day(t.added_at)} · ${dur(t.duration_ms)}`} />
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
    ? `All ${rows.length} arrivals from the last 24 hours.`
    : `${today} in the last 24 hours, plus enough older ones to make ${rows.length}.`;

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
      <p className="note">{all.length.toLocaleString()} recent plays · {here.toLocaleString()} played right here</p>
      <PlayScope tracks={all}>
        <div className="song-grid">
          {all.map((p, i) => (
            <SongCard key={`${p.id}-${i}`} track={p}
              meta={p.played_at ? (p.source === 'app' ? `here · ${ago(p.played_at)}` : ago(p.played_at)) : undefined} />
          ))}
        </div>
      </PlayScope>
    </>
  );
}
