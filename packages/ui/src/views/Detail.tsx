import { useState } from 'react';
import { post } from '../api/client.ts';
import { Link, useParams } from 'react-router-dom';

import { useAlbum, useArtist, useEvents } from '../api/hooks.ts';
import { day, dur } from '../lib/format.ts';
import { AlbumCell, GigCard, TrackRow } from '../components/rows.tsx';
import {
  BandcampButton, Badges, Empty, GenreChips, MediaBadges, Pic, PLAY_ICON,
  PlayControl, RadioControl, Skeleton, SpotifyButton, SpotifyLink,
} from '../components/primitives.tsx';
import { PlayScope, usePlayAll } from '../components/PlayScope.tsx';

export function AlbumDetail() {
  const { id } = useParams();
  const { data, isPending, error } = useAlbum(id);
  const playAll = usePlayAll();
  if (isPending) return <Skeleton />;
  if (error) return <Empty>{error.message}</Empty>;
  const album = data?.album;
  if (!album) return <Empty>unknown album</Empty>;
  const tracks = data!.tracks;

  const meta = [
    (album.release_date ?? '').slice(0, 10), album.album_type,
    album.total_tracks ? `${album.total_tracks} tracks` : '',
    album.label ?? '', album.popularity != null ? `popularity ${album.popularity}` : '',
    album.is_saved ? `saved ${day(album.saved_at)} ✓` : '',
  ].filter(Boolean).join(' · ');

  const discs = [...new Set(tracks.map((t) => t.disc_number ?? 1))].sort((a, b) => a - b);

  return (
    <>
      <div className="hero">
        <Pic kind="albums" id={album.id} cdn={album.image_url} name={album.name} />
        <div>
          <h1>{album.name}</h1>
          <div className="meta">
            {data!.artists.map((x, i) => (
              <span key={`${x.name}-${i}`}>
                {i ? ', ' : ''}
                {x.id ? <Link to={`/artist/${x.id}`}><b>{x.name}</b></Link> : <b>{x.name}</b>}
              </span>
            ))}
          </div>
          <div className="meta">{meta}</div>
          <Badges row={album} />
          <div className="hero-actions">
            {album.downloaded && tracks.length ? (
              <button className="primary-action play-album" type="button" onClick={() => playAll(tracks)}>
                {PLAY_ICON} Play album
              </button>
            ) : null}
            {album.local || !album.id ? null : <SpotifyButton type="album" id={album.id} />}
            <BandcampButton
              query={`${data!.artists[0]?.name ?? ''} ${album.name}`.trim()}
              label={album.downloaded ? 'Bandcamp ↗' : 'Get the FLAC on Bandcamp ↗'}
            />
          </div>
        </div>
      </div>

      {album.id && !album.local ? <AlbumImport id={album.id} artist={data!.artists.map(a => a.name).join(', ')} album={album.name} /> : null}
      <h2>Tracks{tracks.length ? ` (${tracks.length} in library)` : ''}</h2>
      {tracks.length ? (
        <PlayScope tracks={tracks}>
          {discs.map((disc) => (
            <div key={disc}>
              {discs.length > 1 ? <h2>Disc {disc}</h2> : null}
              <div className="rows">
                {tracks.filter((t) => (t.disc_number ?? 1) === disc).map((t) => (
                  // Badges per TRACK, not per album: one folder can mix a
                  // 24-bit rip with a transcode, and this is where that shows.
                  <div className="row" key={t.id}>
                    <span className="rank">{t.track_number ?? ''}</span>
                    <PlayControl track={t} />
                    <span className="heart">{t.liked ? '♥' : ''}</span>
                    <div className="mid">
                      <div>{t.name}</div>
                      <div className="sub">{t.artists ?? ''}</div>
                    </div>
                    <MediaBadges row={t} />
                    <div className="end">{dur(t.duration_ms)}</div>
                    <RadioControl track={t} />
                    {t.id && !t.id.startsWith('lib') ? <SpotifyLink type="track" id={t.id} /> : null}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </PlayScope>
      ) : <Empty>track listing not hydrated yet — next sync runs will fill it in</Empty>}
    </>
  );
}

const RANK_LABEL: Record<string, string> = { short_term: '4w', medium_term: '6mo', long_term: 'yrs' };
const GROUPS: Array<[string, string]> = [
  ['album', 'Albums'], ['single', 'Singles & EPs'], ['compilation', 'Compilations'],
];

export function ArtistDetail() {
  const { id } = useParams();
  const { data, isPending, error } = useArtist(id);
  if (isPending) return <Skeleton />;
  if (error) return <Empty>{error.message}</Empty>;
  const artist = data?.artist;
  if (!artist) return <Empty>unknown artist</Empty>;

  const likedLive = data!.liked.filter((t) => !t.removed_at).length;
  const meta = [
    artist.followers ? `${Number(artist.followers).toLocaleString()} followers` : '',
    artist.popularity != null ? `popularity ${artist.popularity}` : '',
    likedLive ? `${likedLive} liked tracks` : '',
    ...data!.topRanks.map((r) => `#${r.rank} (${RANK_LABEL[r.time_range] ?? r.time_range})`),
  ].filter(Boolean).join(' · ');

  return (
    <>
      <div className="hero">
        <Pic kind="artists" id={artist.id} cdn={artist.image_url} name={artist.name} />
        <div>
          <h1>{artist.is_followed ? '★ ' : ''}{artist.name}</h1>
          <Badges row={artist} />
          <GenreChips json={artist.genres} n={8} />
          <div className="meta">{meta}</div>
          <SpotifyButton type="artist" id={artist.id} />{' '}
          <BandcampButton query={artist.name} type="b" />
        </div>
      </div>

      {data!.events?.length ? (
        <>
          <h2>Upcoming shows</h2>
          <div className="gig-carousel">
            {data!.events!.map((e, i) => (
              <GigCard key={i} index={i} event={{ ...e, artist_name: artist.name, image_url: artist.image_url ?? null }} />
            ))}
          </div>
        </>
      ) : null}

      {artist.discog_synced_at ? null : (
        <div className="note">full discography not crawled yet — showing what the library knows so far</div>
      )}

      {GROUPS.map(([group, title]) => {
        const rows = data!.albums.filter((al) => (al.album_group ?? 'album') === group);
        return rows.length ? (
          <div key={group}>
            <h2>{title} ({rows.length})</h2>
            <div className="al-grid">{rows.map((r) => <AlbumCell key={r.id ?? r.name} album={r} />)}</div>
          </div>
        ) : null;
      })}
      {data!.albums.length ? null : <Empty>no albums known yet</Empty>}

      {data!.liked.length ? (
        <>
          <h2>Liked tracks</h2>
          <PlayScope tracks={data!.liked}>
            <div className="rows">
              {data!.liked.map((t) => <TrackRow key={t.id} track={t} endText={day(t.added_at)} />)}
            </div>
          </PlayScope>
        </>
      ) : null}
    </>
  );
}

export function Shows() {
  const { data, isPending, error } = useEvents();
  if (isPending) return <Skeleton />;
  if (error) return <Empty>{error.message}</Empty>;
  const d = data!;
  if (!d.near.length && !d.elsewhere.length) {
    return <Empty>no shows known yet — needs a (free) Ticketmaster API key</Empty>;
  }
  return (
    <>
      <h2>Near you ({d.countries.join(', ')})</h2>
      {d.near.length
        ? <div className="gig-grid">{d.near.map((e, i) => <GigCard key={i} event={e} index={i} />)}</div>
        : <Empty>nothing announced nearby</Empty>}
      {d.elsewhere.length ? (
        <>
          <h2>Elsewhere ({d.elsewhere.length})</h2>
          <div className="gig-grid">{d.elsewhere.map((e, i) => <GigCard key={i} event={e} index={i} />)}</div>
        </>
      ) : null}
    </>
  );
}

function AlbumImport({ id, artist, album }: { id: string; artist: string; album: string }) {
  const [mode, setMode] = useState('tracks');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function submit() {
    setBusy(true); setMessage('');
    try {
      await post(mode === 'tracks' ? '/api/albums/import-tracks' : '/api/upgrades', mode === 'tracks'
        ? { albumId: id }
        : { sourceUrl: url, sourceMode: mode, artist, album, title: album, downloader: 'yt-dlp' });
      setMessage('Album queued. Follow progress in the FLAC queue.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <details><summary>Add whole album to archive</summary>
    <form className="tools" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <select aria-label="Album import method" value={mode} onChange={e => setMode(e.target.value)}>
        <option value="tracks">Find each song on YouTube</option>
        <option value="chapters">Split full album video by chapters</option>
        <option value="playlist">YouTube album playlist</option>
      </select>
      {mode !== 'tracks' && <input type="url" aria-label="YouTube album URL" placeholder="YouTube URL" required value={url} onChange={e => setUrl(e.target.value)} />}
      <button disabled={busy}>Add album</button>
    </form>
    <p>Existing library recordings are kept. Full album videos need chapters to split tracks.</p>
    <p role="status">{message}</p>
  </details>;
}
