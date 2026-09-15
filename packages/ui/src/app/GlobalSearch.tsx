import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get, qs } from '../api/client.ts';
import type { Album, Artist, Playlist, Track } from '../api/types.ts';
import { useDebounced } from '../lib/useDebounced.ts';
import { AlbumCell, SongCard } from '../components/rows.tsx';
import { PlayScope } from '../components/PlayScope.tsx';

interface Results { songs: Track[]; artists: Artist[]; albums: Album[]; playlists: Playlist[] }

export function GlobalSearch({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pageScroll = useRef(0);
  const location = useLocation();
  const term = query.trim();
  const debounced = useDebounced(term, 300);
  const results = useQuery({
    queryKey: ['global-search', debounced],
    queryFn: ({ signal }) => get<Results>(`/api/search${qs({ q: debounced })}`, { signal }),
    enabled: open && debounced.length >= 2,
    staleTime: 60_000,
  });
  function close() { setOpen(false); setQuery(''); input.current?.focus({ preventScroll: true }); requestAnimationFrame(() => window.scrollTo(0, pageScroll.current)); }
  useEffect(() => { setOpen(false); setQuery(''); }, [location.key]);
  useEffect(() => {
    function shortcut(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); input.current?.focus(); }
      if (e.key === 'Escape' && open) { e.preventDefault(); close(); }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [open]);
  const loading = term !== debounced || results.isPending;
  const data = !loading && !results.error ? results.data : undefined;
  return <>
    <div className="global-search-bar" role="search">
      <input ref={input} type="search" aria-label="Search music" placeholder="Search songs, artists, albums, playlists"
        maxLength={200} value={query} aria-controls="search-results" aria-expanded={open}
        onFocus={() => { if (term) setOpen(true); }}
        onChange={e => {
          if (!open) pageScroll.current = window.scrollY;
          setQuery(e.target.value);
          const next = !!e.target.value.trim();
          setOpen(next);
          if (next && !open) window.scrollTo(0, 0);
          if (!next) requestAnimationFrame(() => window.scrollTo(0, pageScroll.current));
        }} />
      {open && <button type="button" onClick={close}>Close search</button>}
    </div>
    <div hidden={open}>{children}</div>
    {open && <section id="search-results" className="search-results" aria-label="Search results">
      <h1>Search results</h1>
      {term.length < 2 ? <p role="status">Type at least two characters.</p>
        : loading ? <p role="status">Searching...</p>
        : results.error ? <div role="alert">Could not search your library. <button onClick={() => void results.refetch()}>Retry</button></div>
        : data && !Object.values(data).some(rows => rows.length) ? <p role="status">No music found for "{term}".</p> : null}
      {data && <>
        {!!data.songs.length && <section><h2>Songs{data.songs.length === 100 ? ' · first 100 matches' : ''}</h2>
          <PlayScope tracks={data.songs}><div className="song-grid">{data.songs.map(track => <SongCard key={track.id} track={track} />)}</div></PlayScope></section>}
        {!!data.artists.length && <section><h2>Artists</h2><div className="search-links">{data.artists.map(a => <Link key={a.id} to={`/artist/${encodeURIComponent(a.id)}`}>{a.name}</Link>)}</div></section>}
        {!!data.albums.length && <section><h2>Albums</h2><div className="al-grid">{data.albums.map(a => <AlbumCell key={a.id} album={a} />)}</div></section>}
        {!!data.playlists.length && <section><h2>Playlists</h2><div className="search-links">{data.playlists.map(p => <Link key={p.id} to={`/playlist/${encodeURIComponent(p.id)}`}>{p.name}</Link>)}</div></section>}
      </>}
    </section>}
  </>;
}
