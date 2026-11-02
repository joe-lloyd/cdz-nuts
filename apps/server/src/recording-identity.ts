import { lengthsDisagree } from './jellyfin.ts';
import { albumNameKey } from './provenance.ts';

export interface RecordingHint {
  recordingMbid?: string | null;
  album?: string | null;
  durationMs?: number | null;
}

/** Known recording IDs win; otherwise reject conflicting available metadata. */
export function sameRecording(known: RecordingHint, wanted: RecordingHint): boolean {
  if (known.recordingMbid && wanted.recordingMbid) {
    return known.recordingMbid.toLowerCase() === wanted.recordingMbid.toLowerCase();
  }
  if (lengthsDisagree(known.durationMs, wanted.durationMs)) return false;
  const key = (album?: string | null) => albumNameKey(album) || album?.trim().toLocaleLowerCase() || '';
  const a = key(known.album), b = key(wanted.album);
  return !a || !b || a === b;
}
