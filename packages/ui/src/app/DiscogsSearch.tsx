// Music the library does not hold yet, found on Discogs and added with a click.
//
// Offered under the local results rather than mixed into them: the library
// answers first and instantly, and Discogs is asked only when the user wants
// to look further, because every search spends part of a 60-a-minute budget.
// All Discogs traffic goes through our own /api, which holds the credentials.
import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post, qs } from '../api/client.ts';
import type {
  DiscogsAdded, DiscogsAlbumDetail, DiscogsAlbumHit, DiscogsArtistDetail, DiscogsArtistHit, DiscogsSearch as Found,
} from '../api/types.ts';
import { dur, initial } from '../lib/format.ts';
import { player } from '../player/usePlayer.ts';

/** Every query a newly added album or artist can show up in. */
const LIBRARY_QUERIES = [
  'global-search', 'discogs-search', 'discogs-artist', 'discogs-album',
  'albums', 'artists', 'artist', 'album', 'overview', 'stats',
];
const CATALOGUE = 5 * 60_000;

/** The server's own words, plus the reassurance that matters most. */
function problem(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
  if (error instanceof ApiError && error.status === 503) {
    return `${text}. Whoever runs the server can add a Discogs token to switch it on. Your library search still works.`;
  }
  return `${text}. Your library search still works.`;
}

function Cover({ src, name, round = false }: { src: string | null; name: string; round?: boolean }) {
  const [failed, setFailed] = useState(!src);
  return (
    <div className={`pic ${round ? 'pic-artists' : 'pic-albums'}`}>
      {failed ? <div className="ph">{initial(name)}</div>
        // Discogs serves its images only to requests without a foreign referrer.
        : <img src={src ?? ''} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
    </div>
  );
}

/** "In library" when held, otherwise the button that adds it. */
function LibraryAction({ kind, id, name, library }: {
  kind: 'artist' | DiscogsAlbumHit['kind']; id: number; name: string; library: string | null;
}) {
  const client = useQueryClient();
  const add = useMutation({
    mutationFn: () => post<DiscogsAdded>('/api/discogs/add', { kind, id }),
    onSuccess: (result) => {
      player.notify(result.added ? `Added ${name} to your library` : `${name} is already in your library`);
      for (const key of LIBRARY_QUERIES) void client.invalidateQueries({ queryKey: [key] });
    },
    onError: (error: Error) => player.notify(`Could not add ${name}. ${problem(error)}`, true),
  });
  const held = add.data?.id ?? library;
  if (held) {
    return (
      <Link className="discogs-held" to={`/${kind === 'artist' ? 'artist' : 'album'}/${encodeURIComponent(held)}`}
        aria-label={`Open ${name} in your library`}>In library</Link>
    );
  }
  return (
    <button type="button" className="discogs-add" disabled={add.isPending} aria-label={`Add ${name} to library`}
      onClick={() => add.mutate()}>
      {add.isPending ? 'Adding…' : 'Add to library'}
    </button>
  );
}

function Tracklist({ album }: { album: DiscogsAlbumHit }) {
  const detail = useQuery({
    queryKey: ['discogs-album', album.kind, album.id],
    queryFn: ({ signal }) => get<DiscogsAlbumDetail>(`/api/discogs/album${qs({ kind: album.kind, id: album.id })}`, { signal }),
    retry: false,
    staleTime: CATALOGUE,
  });
  return (
    <div className="discogs-panel" role="region" aria-label={`Tracks of ${album.title}`}>
      {detail.isPending ? <p role="status">Loading tracks…</p>
        : detail.error ? <div role="alert" className="discogs-error">{problem(detail.error)}
          <button type="button" onClick={() => void detail.refetch()}>Try again</button></div>
        : !detail.data.album.tracks.length ? <p>Discogs lists no tracks for this album.</p>
        : <ol className="discogs-tracks">
          {detail.data.album.tracks.map((track, index) => (
            <li key={`${index}-${track.position}`}>
              <span className="pos">{track.position || index + 1}</span>
              <span className="title">{track.title}</span>
              <span className="dur">{dur(track.durationMs)}</span>
            </li>
          ))}
        </ol>}
    </div>
  );
}

function AlbumGrid({ albums }: { albums: DiscogsAlbumHit[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="discogs-grid">
      {albums.map((album) => {
        const key = `${album.kind}:${album.id}`;
        const shown = open === key;
        return (
          <Fragment key={key}>
            <div className="al-card discogs-card">
              <span className="al-art"><Cover src={album.image} name={album.title} /></span>
              <div className="al-body">
                <b>{album.title}</b>
                <span className="sub">{album.artist}</span>
                <span className="sub dim">{[album.year, album.format].filter(Boolean).join(' · ')}</span>
              </div>
              <div className="cd-actions">
                <button type="button" className="ghost" aria-expanded={shown}
                  aria-label={`${shown ? 'Hide' : 'Show'} tracks of ${album.title}`}
                  onClick={() => setOpen(shown ? null : key)}>Tracks</button>
                <LibraryAction kind={album.kind} id={album.id} name={album.title} library={album.library} />
              </div>
            </div>
            {shown ? <Tracklist album={album} /> : null}
          </Fragment>
        );
      })}
    </div>
  );
}

function ArtistAlbums({ artist }: { artist: DiscogsArtistHit }) {
  const detail = useQuery({
    queryKey: ['discogs-artist', artist.id],
    queryFn: ({ signal }) => get<DiscogsArtistDetail>(`/api/discogs/artist${qs({ id: artist.id })}`, { signal }),
    retry: false,
    staleTime: CATALOGUE,
  });
  return (
    <div className="discogs-panel" role="region" aria-label={`Albums by ${artist.name}`}>
      {detail.isPending ? <p role="status">Loading albums…</p>
        : detail.error ? <div role="alert" className="discogs-error">{problem(detail.error)}
          <button type="button" onClick={() => void detail.refetch()}>Try again</button></div>
        : detail.data.albums.length ? <>
          <AlbumGrid albums={detail.data.albums} />
          {detail.data.truncated ? <p className="sub discogs-note">Discogs lists more for {artist.name} than was read here, so this list may be incomplete.</p> : null}
        </>
        // Cut short and empty means only that the part read held no albums of
        // their own, not that Discogs has none.
        : detail.data.truncated ? <p>No albums of {artist.name}'s own in the part of their Discogs listing read here. The listing was cut short, so Discogs may have more.</p>
        : <p>Discogs lists no albums for {artist.name}.</p>}
    </div>
  );
}

export function DiscogsSearch({ term, hasLocal }: { term: string; hasLocal: boolean }) {
  // The term the user asked Discogs about. Typing something new puts the
  // offer back rather than spending a request on every keystroke.
  const [asked, setAsked] = useState<string | null>(null);
  const [openArtist, setOpenArtist] = useState<number | null>(null);
  const active = asked === term;
  const found = useQuery({
    queryKey: ['discogs-search', term],
    queryFn: ({ signal }) => get<Found>(`/api/discogs/search${qs({ q: term })}`, { signal }),
    enabled: active,
    // A rate limit or an outage is not helped by asking again at once.
    retry: false,
    staleTime: CATALOGUE,
  });
  const data = active && !found.error ? found.data : undefined;
  return (
    <section className="discogs" aria-labelledby="discogs-heading">
      <h2 id="discogs-heading">On Discogs</h2>
      {!active ? (
        <div className="discogs-offer">
          <p className="sub">{hasLocal ? 'Looking for something the library does not have?' : 'Nothing in the library yet.'} Search Discogs for “{term}” and add what you find.</p>
          <button type="button" className="primary-action" onClick={() => { setAsked(term); setOpenArtist(null); }}>Search Discogs</button>
        </div>
      ) : found.isPending ? <p role="status">Searching Discogs…</p>
        : found.error ? <div role="alert" className="discogs-error">{problem(found.error)}
          <button type="button" onClick={() => void found.refetch()}>Try again</button></div>
        : null}
      {data && !data.artists.length && !data.albums.length ? <p role="status">Discogs has nothing for “{term}”.</p> : null}
      {data && data.artists.length ? <>
        <h3>Artists</h3>
        <div className="discogs-grid">
          {data.artists.map((artist) => {
            const shown = openArtist === artist.id;
            return (
              <Fragment key={artist.id}>
                <div className="al-card discogs-card">
                  <span className="al-art"><Cover src={artist.image} name={artist.name} round /></span>
                  <div className="al-body"><b>{artist.name}</b><span className="sub dim">Artist</span></div>
                  <div className="cd-actions">
                    <button type="button" className="ghost" aria-expanded={shown}
                      aria-label={`${shown ? 'Hide' : 'Show'} albums by ${artist.name}`}
                      onClick={() => setOpenArtist(shown ? null : artist.id)}>Albums</button>
                    <LibraryAction kind="artist" id={artist.id} name={artist.name} library={artist.library} />
                  </div>
                </div>
                {shown ? <ArtistAlbums artist={artist} /> : null}
              </Fragment>
            );
          })}
        </div>
      </> : null}
      {data && data.albums.length ? <><h3>Albums</h3><AlbumGrid albums={data.albums} /></> : null}
    </section>
  );
}
