import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLikedTracks } from '../api/hooks.ts';
import { post } from '../api/client.ts';
import type { Track } from '../api/types.ts';

export function LikeButton({ track }: { track: Track }) {
  const cache = useQueryClient();
  const likes = useLikedTracks();
  const liked = likes.data?.some(t => t.id === track.id) ?? false;
  const change = useMutation({
    mutationFn: () => post('/api/likes', { id: track.id, liked: !liked }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ['tracks', 'liked'] }),
  });
  return <span className="like-control">
    <button type="button" className="like-button" aria-pressed={liked}
      aria-label={`${liked ? 'Remove' : 'Add'} ${track.name} ${liked ? 'from' : 'to'} liked songs`}
      title={likes.error ? 'Liked songs could not be loaded' : undefined}
      disabled={likes.isPending || !!likes.error || change.isPending} onClick={() => change.mutate()}>
      {liked ? '♥' : '♡'}
    </button>
    {change.error && <span role="alert">Could not save like. Try again.</span>}
  </span>;
}
