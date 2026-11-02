import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { post } from '../api/client.ts';
import type { Track } from '../api/types.ts';

type Spec = { artist: string; title: string; album: string | null; durationMs: number | null };
export type DownloadStatus = {
  key: string; ready: boolean; stage: string; status: string; phase: string | null;
  sourceAttempts: number; nextAttemptAt: string | null; error: string | null;
};
type Registry = Map<string, { spec: Spec; count: number }>;
const Context = createContext<{
  register: (key: string, spec: Spec) => () => void;
  statuses: Map<string, DownloadStatus>; failed: boolean; refresh: () => void;
} | null>(null);

/** One poll for the visible list, in bounded batches, rather than a request per song. */
export function DownloadProgressProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [registry, setRegistry] = useState<Registry>(new Map());
  const register = useCallback((key: string, spec: Spec) => {
    setRegistry(previous => {
      const next = new Map(previous);
      next.set(key, { spec, count: (next.get(key)?.count ?? 0) + 1 });
      return next;
    });
    return () => setRegistry(previous => {
      const next = new Map(previous);
      const entry = next.get(key);
      if (entry && entry.count > 1) next.set(key, { ...entry, count: entry.count - 1 });
      else next.delete(key);
      return next;
    });
  }, []);
  const specs = useMemo(() => [...registry].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry.spec), [registry]);
  const query = useQuery({
    queryKey: ['download-progress', specs], enabled: specs.length > 0,
    queryFn: async ({ signal }) => {
      const results: DownloadStatus[] = [];
      for (let offset = 0; offset < specs.length; offset += 40) {
        const response = await post<{ results: DownloadStatus[] }>('/api/radio/resolve', { tracks: specs.slice(offset, offset + 40) }, { signal });
        results.push(...response.results);
      }
      return results;
    },
    staleTime: 0, retry: 1,
    refetchInterval: query => query.state.data?.some(item => !item.ready && (item.stage === 'indexing' || !['not-queued', 'exhausted', 'cancelled'].includes(item.status))) ? 5_000 : 30_000,
  });
  const statuses = useMemo(() => new Map(query.data?.map(status => [status.key, status])), [query.data]);
  const refresh = useCallback(() => { void client.invalidateQueries({ queryKey: ['download-progress'] }); }, [client]);
  return <Context value={{ register, statuses, failed: query.isError, refresh }}>{children}</Context>;
}

export function useDownloadProgress(track: Track, held: boolean) {
  const context = useContext(Context);
  const register = context?.register;
  const artist = track.artists ?? track.artist_name ?? '';
  const title = track.name;
  const album = track.album ?? null;
  const durationMs = track.duration_ms ?? null;
  const key = `${artist}|${title}`;
  useEffect(() => {
    if (!held && track.id && register) return register(key, { artist, title, album, durationMs });
  }, [held, track.id, register, key, artist, title, album, durationMs]);
  return { status: context?.statuses.get(key), failed: context?.failed ?? false, refresh: context?.refresh };
}

export function downloadLabel(status?: DownloadStatus): string | null {
  if (!status || status.status === 'not-queued' && !status.ready && status.stage !== 'indexing') return null;
  if (status.ready) return 'Ready to play';
  if (status.stage === 'indexing') return 'Downloaded · preparing playback';
  if (status.status === 'exhausted' || status.status === 'cancelled') return 'Download stopped · retry';
  if (status.status === 'retry_wait') return 'Download failed · retry scheduled';
  if (status.phase === 'source' && status.status === 'working') return 'Downloading from YouTube…';
  if (status.phase === 'upgrade') return 'Downloaded · preparing playback';
  return 'Waiting for download…';
}
