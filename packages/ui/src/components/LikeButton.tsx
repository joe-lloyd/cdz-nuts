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
function LikeToggle({ kind, id, name, liked, list }: {
  kind: Kind; id: string; name: string; liked: boolean; list: { isPending: boolean; error: Error | null };
}) {
  const cache = useQueryClient();
  const change = useMutation({
    mutationFn: () => post<LikeReply>('/api/likes', { id, liked: !liked, kind }),
    onSuccess: () => cache.invalidateQueries({ queryKey: LIST[kind].key }),
  });
  const grabbed = change.data?.grabbed ?? null;
  return <span className="like-control">
    <button type="button" className="like-button" aria-pressed={liked}
      aria-label={`${liked ? 'Remove' : 'Add'} ${name} ${liked ? 'from' : 'to'} ${LIST[kind].name}`}
      title={list.error ? `${LIST[kind].name} could not be loaded` : undefined}
      disabled={list.isPending || !!list.error || change.isPending} onClick={() => change.mutate()}>
      {liked ? '♥' : '♡'}
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
  return <LikeToggle kind="album" id={id} name={album.name} liked={liked} list={list} />;
}

export function ArtistLikeButton({ artist }: { artist: Artist }) {
  const list = useArtists();
  const liked = list.data?.some(a => a.id === artist.id && Boolean(a.liked)) ?? false;
  return <LikeToggle kind="artist" id={artist.id} name={artist.name} liked={liked} list={list} />;
}
