import { createContext, use, type ReactNode } from 'react';

import { player, type QueueItem } from '../player/engine.ts';
import type { Track } from '../api/types.ts';

/**
 * The list a play button belongs to.
 *
 * This replaces `setQueueFromButtons`, which rebuilt the queue by reading six
 * `data-*` attributes back out of the rendered DOM and scoping the search to
 * `.rows` or `#main`. That worked, but it meant the queue could only contain
 * what happened to be on screen, and it coupled playback to markup.
 *
 * Here the scope carries the data directly, so a row renders from the same
 * objects the queue is built from and nothing is serialised through the DOM.
 */
interface Scope {
  tracks: Track[];
  /** A station should not continue into album autoplay when it runs out. */
  continueAfter: boolean;
}

const PlayScopeContext = createContext<Scope | null>(null);

export function PlayScope({ tracks, continueAfter = true, children }: {
  tracks: Track[];
  continueAfter?: boolean | undefined;
  children: ReactNode;
}) {
  return <PlayScopeContext value={{ tracks, continueAfter }}>{children}</PlayScopeContext>;
}

export const toQueueItem = (t: Track): QueueItem => ({
  id: t.id,
  name: t.name || 'Unknown track',
  artists: t.artists ?? t.artist_name ?? '',
  durationMs: Number(t.duration_ms ?? 0),
  albumId: t.album_id ?? '',
  imageUrl: t.image_url ?? '',
});

/** Start playback from a track, queueing the whole scope it sits in. */
export function usePlayFromScope(): (track: Track) => void {
  const scope = use(PlayScopeContext);
  return (track: Track) => {
    // Without a scope the track plays alone, which is the honest fallback --
    // better than silently queueing something the user cannot see.
    const list = scope?.tracks.length ? scope.tracks : [track];
    player.setQueue(list.map(toQueueItem), track.id, scope?.continueAfter ?? true);
    const index = list.findIndex((t) => t.id === track.id);
    void player.playAt(Math.max(0, index));
  };
}

/** Play a whole list from the top — the "Play album" / "Play station" button. */
export function usePlayAll(): (tracks: Track[], continueAfter?: boolean) => void {
  return (tracks, continueAfter = true) => {
    const playable = tracks.filter((t) => t.id);
    if (!playable.length) return;
    player.setQueue(playable.map(toQueueItem), playable[0]!.id, continueAfter);
    void player.playAt(0);
  };
}
