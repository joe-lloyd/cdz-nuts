// One hook per endpoint.
//
// This replaces the old `cache = {}` that memoised every URL forever with no
// expiry, no invalidation and no eviction, plus the hand-rolled generation
// counters that existed only to drop out-of-order responses. Query does both,
// and does them for every caller at once.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { get, getFresh, qs } from './client.ts';
import type {
  Album, AlbumDetail, Artist, ArtistDetail, Cds, Continuation, Events,
  ListenBrainz, Overview, PlayerStatus, Playlist, Provenance, RadioStation,
  Releases, Stats, Track, Upgrades, Wrapped,
} from './types.ts';

/** The archive changes on a nightly sync, so this is generous on purpose. */
const ARCHIVE = 5 * 60_000;

const query = <T>(key: unknown[], path: string, staleTime = ARCHIVE) =>
  useQuery({ queryKey: key, queryFn: () => get<T>(path), staleTime });

export const useOverview = () => query<Overview>(['overview'], '/api/overview');
export const useStats = () => query<Stats>(['stats'], '/api/stats');
export const useProvenance = () => query<Provenance>(['provenance'], '/api/provenance');
export const useReleases = () => query<Releases>(['releases'], '/api/releases');
export const useArtists = () => query<Artist[]>(['artists'], '/api/artists');
export const useSavedAlbums = () => query<Album[]>(['albums', 'saved'], '/api/albums');
export const useLibraryAlbums = () => query<Album[]>(['albums', 'library'], '/api/library-albums');
export const usePlaylists = () => query<Playlist[]>(['playlists'], '/api/playlists');
export const useLikedTracks = () => query<Track[]>(['tracks', 'liked'], '/api/tracks');
export const usePlays = () => query<Track[]>(['plays'], '/api/plays');
export const useLatest = () => query<Album[]>(['latest'], '/api/latest');
export const useEvents = () => query<Events>(['events'], '/api/events');
export const useListenBrainz = () => query<ListenBrainz>(['listenbrainz'], '/api/listenbrainz');
export const useCds = () => query<Cds>(['cds'], '/api/cds');

/** Imported here rather than liked. Absent on an archive with none. */
export const useLocalTracks = (): UseQueryResult<Track[]> =>
  useQuery({
    queryKey: ['tracks', 'local'],
    queryFn: async () => {
      try { return await get<Track[]>('/api/local-tracks'); } catch { return []; }
    },
    staleTime: ARCHIVE,
  });

export const useAlbum = (id: string | undefined) =>
  useQuery({
    queryKey: ['album', id],
    queryFn: () => get<AlbumDetail>(`/api/album${qs({ id })}`),
    enabled: Boolean(id),
    staleTime: ARCHIVE,
  });

export const useArtist = (id: string | undefined) =>
  useQuery({
    queryKey: ['artist', id],
    queryFn: () => get<ArtistDetail>(`/api/artist${qs({ id })}`),
    enabled: Boolean(id),
    staleTime: ARCHIVE,
  });

export const usePlaylistTracks = (id: string | undefined) =>
  useQuery({
    queryKey: ['playlist-tracks', id],
    queryFn: () => get<Track[]>(`/api/playlist-tracks${qs({ id })}`),
    enabled: Boolean(id),
    staleTime: ARCHIVE,
  });

export const useTopArtists = (range?: string) =>
  query<Artist[]>(['top-artists', range ?? 'default'], `/api/top-artists${qs({ range })}`);

export const useTopTracks = (range: string) =>
  query<Track[]>(['top-tracks', range], `/api/top-tracks${qs({ range })}`);

export const useWrapped = (from: string, to: string) =>
  query<Wrapped>(['wrapped', from, to], `/api/wrapped${qs({ from, to })}`);

export const useStation = (kind: string | undefined, value: string | undefined) =>
  useQuery({
    queryKey: ['radio', kind, value],
    queryFn: () => {
      // A song station is seeded from the track itself; everything else is a name.
      const params = kind === 'track'
        ? qs({ kind: 'track', from: value, limit: 40 })
        : qs({ kind, value, limit: 40 });
      return get<RadioStation>(`/api/radio${params}`);
    },
    enabled: Boolean(kind && value),
    staleTime: ARCHIVE,
  });

/**
 * The FLAC queue, which the worker changes underneath us.
 *
 * `refetchInterval` replaces a hand-rolled setInterval whose cleanup was lazy
 * -- it checked `el.isConnected` on the next tick, so it kept polling for up
 * to twelve seconds after you navigated away. Query stops the moment the last
 * observer unmounts.
 */
export const useUpgrades = () =>
  useQuery({
    queryKey: ['upgrades'],
    queryFn: () => getFresh<Upgrades>('/api/upgrades'),
    refetchInterval: 12_000,
    staleTime: 0,
  });

export const usePlayerStatus = () =>
  useQuery({
    queryKey: ['player-status'],
    queryFn: () => getFresh<PlayerStatus>('/api/player/status'),
    refetchInterval: 60_000,
    staleTime: 0,
  });

export type { Continuation };
