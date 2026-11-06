import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useArtists, useLikedTracks, useSavedAlbums } from '../api/hooks.ts';
import { post } from '../api/client.ts';
import type { Album, Artist, Track } from '../api/types.ts';

type Kind = 'track' | 'album' | 'artist';
type Grabbed = { queued: number; skipped: number; lossless: number };
type LikeReply = { grabbed: Grabbed | null };

/** Which list a heart adds to, and which cached list to refetch afterwards. */
const LIST: Record<Kind, { name: string; key: string[] }> = {
  track: { name: 'liked songs', key: ['tracks', 'liked'] },
  album: { name: 'saved albums', key: ['albums', 'saved'] },
  artist: { name: 'favourite artists', key: ['artists'] },
};

/** A heart for a song, a person for an artist you follow, a bookmark for a saved album. */
const GLYPH: Record<Kind, (on: boolean) => ReactNode> = {
  track: () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7.5-4.6-9.3-9.2C1.4 7.4 3.6 4 7 4c2.1 0 3.6 1.1 5 3 1.4-1.9 2.9-3 5-3 3.4 0 5.6 3.4 4.3 6.8C19.5 15.4 12 20 12 20Z" /></svg>,
  artist: (on) => <svg className="glyph-line" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="8" r="4" /><path d="M3 20a7 7 0 0 1 14 0" />{on ? <path d="m16 11 2 2 4-4" /> : <path d="M19 8v6M16 11h6" />}</svg>,
  album: (on) => <svg className="glyph-line" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z" className={on ? 'glyph-fill' : undefined} /></svg>,
};

function grabbedText({ queued }: Grabbed) {
  if (queued === 1) return 'Queued for the archive';
  return queued ? `${queued} songs queued for the archive` : 'Already in the archive';
}

/**
 * A heart means the same thing on a song, an album or an artist: it goes in
 * the list, and the archive goes and gets every song it covers. The reply
 * says how many that was, which is the only feedback a whole-discography
 * grab gives before the FLAC queue fills.
 */
function LikeToggle({ kind, id, name, liked, list, words }: {
  kind: Kind; id: string; name: string; liked: boolean; list: { isPending: boolean; error: Error | null };
  /** The word beside the heart, on and off, where a heart alone would be ambiguous. */
  words?: [string, string] | undefined;
}) {
  const cache = useQueryClient();
  const change = useMutation({
    mutationFn: () => post<LikeReply>('/api/likes', { id, liked: !liked, kind }),
    onSuccess: () => cache.invalidateQueries({ queryKey: LIST[kind].key }),
  });
  const grabbed = change.data?.grabbed ?? null;
  return <span className="like-control">
    <button type="button" className={`like-button${words ? ' worded' : ''}`} aria-pressed={liked}
      aria-label={`${liked ? 'Remove' : 'Add'} ${name} ${liked ? 'from' : 'to'} ${LIST[kind].name}`}
      title={list.error ? `${LIST[kind].name} could not be loaded` : undefined}
      disabled={list.isPending || !!list.error || change.isPending} onClick={() => change.mutate()}>
      {GLYPH[kind](liked)}
      {words ? <span aria-hidden="true">{liked ? words[0] : words[1]}</span> : null}
    </button>
    {change.error && <span role="alert">Could not save like. Try again.</span>}
    {grabbed && <span role="status">{grabbedText(grabbed)}</span>}
  </span>;
}

export function LikeButton({ track }: { track: Track }) {
  const list = useLikedTracks();
  const liked = list.data?.some(t => t.id === track.id) ?? false;
  return <LikeToggle kind="track" id={track.id} name={track.name} liked={liked} list={list} />;
}

export function AlbumLikeButton({ album }: { album: Album }) {
  const list = useSavedAlbums();
  const id = album.id ?? album.album_id;
  if (!id) return null;
  const liked = list.data?.some(a => (a.id ?? a.album_id) === id && Boolean(a.liked)) ?? false;
  return <LikeToggle kind="album" id={id} name={album.name} liked={liked} list={list} words={['Saved', 'Save']} />;
}

export function ArtistLikeButton({ artist }: { artist: Artist }) {
  const list = useArtists();
  const liked = list.data?.some(a => a.id === artist.id && Boolean(a.liked)) ?? false;
  return <LikeToggle kind="artist" id={artist.id} name={artist.name} liked={liked} list={list} words={['Following', 'Follow']} />;
}
