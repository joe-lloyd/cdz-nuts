// Which covers a playlist made in the app wears on its card.
//
// Spotify playlists show the first four albums they play. A playlist made here
// shows four of its albums picked at random, or as many as it has when that is
// fewer, so the card looks like what is inside it.
//
// "At random" is seeded by the albums the playlist holds. A fresh draw on
// every request would reshuffle the card each time the list reloads; this way
// a playlist keeps its picture until its albums change, and every server
// that answers for it draws the same one.

export interface Cover {
  album_id: string | null;
  image_url: string | null;
}

interface CoverSource {
  album_id?: string | null;
  image_url?: string | null;
}

/** Albums whose covers the server hosts from the library rather than by Spotify id. */
const LOCAL_ART = /^(localalbum|libalbum)-|^rg:/;

/** The URL the app serves an album's cover at. The same rule as the UI's artUrl. */
export function hostedCover(albumId: string): string {
  return LOCAL_ART.test(albumId)
    ? `/img/local/${encodeURIComponent(albumId)}.jpg`
    : `/img/albums/${encodeURIComponent(albumId)}.jpg`;
}

/**
 * Up to `count` covers from distinct albums among `tracks`, in an order that
 * looks random but is the same every time for the same albums. A track with
 * neither an album id nor an image has no cover to offer.
 */
export function pickCovers(tracks: CoverSource[], count = 4): Cover[] {
  const albums = new Map<string, Cover>();
  for (const track of tracks) {
    const albumId = track.album_id || null;
    const imageUrl = track.image_url || null;
    const key = albumId ?? imageUrl;
    if (!key || albums.has(key)) continue;
    albums.set(key, { album_id: albumId, image_url: imageUrl });
  }
  const keys = [...albums.keys()].sort();
  const random = mulberry32(fnv1a(keys.join('\n')));
  // Fisher-Yates over the sorted keys, so the draw does not depend on the
  // order the songs happen to be in.
  for (let i = keys.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
  }
  return keys.slice(0, count).map((key) => albums.get(key)!);
}

/** The URLs an older UI reads from `images`: hosted art where there is an album id. */
export function coverUrls(covers: Cover[]): string[] {
  return covers.map((cover) => (cover.album_id ? hostedCover(cover.album_id) : cover.image_url ?? ''))
    .filter(Boolean);
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
