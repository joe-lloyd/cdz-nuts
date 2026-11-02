import { lengthsDisagree } from './jellyfin.ts';
import { albumNameKey, provenanceKey } from './provenance.ts';
import type { LocalTrack } from './upgrades.ts';

/** Index once per batch; an empty normalized identity is never a match. */
export function indexInstalledTracks(tracks: LocalTrack[]): Map<string, LocalTrack[]> {
  const index = new Map<string, LocalTrack[]>();
  for (const track of tracks) {
    const key = provenanceKey(track.artists, track.name);
    if (!key) continue;
    const group = index.get(key);
    if (group) group.push(track);
    else index.set(key, [track]);
  }
  return index;
}

export function matchInstalledTrack(
  index: Map<string, LocalTrack[]>, artist: string, title: string,
  hint: { album?: string | null; durationMs?: number | null } = {},
): LocalTrack | undefined {
  const key = provenanceKey(artist, title);
  if (!key) return undefined;
  const candidates = (index.get(key) ?? []).filter(track => !lengthsDisagree(track.duration_ms, hint.durationMs));
  const album = albumNameKey(hint.album);
  return (album ? candidates.find(track => albumNameKey(track.album) === album) : undefined) ?? candidates[0];
}
