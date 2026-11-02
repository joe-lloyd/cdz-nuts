import { primaryArtist } from './radio.ts';

export interface SongRadioSeed {
  title: string;
  artist: string;
  recordingMbid?: string | null;
  artistMbid?: string | null;
}
interface SeedRequest { from: string; title?: string | null; artist?: string | null; recordingMbid?: string }

/** Resolve catalog songs and radio candidates to the recording similarity API's identity. */
export async function resolveSongRadioSeed(
  request: SeedRequest,
  find: (id: string) => SongRadioSeed | null,
  lookup: (artist: string, title: string) => Promise<{ recordingMbid: string; artistMbids: string[] } | null>,
): Promise<SongRadioSeed | null> {
  const known = find(request.from);
  const title = known?.title || request.title?.trim() || '';
  const artist = known?.artist || request.artist?.trim() || '';
  let recordingMbid = request.recordingMbid || known?.recordingMbid || null;
  let artistMbid = known?.artistMbid || null;
  if (!title || (!artist && !recordingMbid)) return null;
  if (!recordingMbid && artist) {
    try {
      const found = await lookup(primaryArtist(artist), title);
      recordingMbid = found?.recordingMbid ?? null;
      artistMbid ||= found?.artistMbids[0] ?? null;
    } catch { /* Artist radio still works if recording lookup is unavailable. */ }
  }
  return { title, artist, recordingMbid, artistMbid };
}
