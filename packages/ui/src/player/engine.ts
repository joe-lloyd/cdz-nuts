// The audio engine. Deliberately NOT a React component.
//
// Two HTMLAudioElements, one of which is never in the document: `next()` swaps
// which one is active rather than re-fetching, and that swap IS how gapless
// playback works. Neither element may ever be unmounted, re-created, or
// double-invoked by Strict Mode, so both live here, created once, outside
// React's lifecycle entirely. React subscribes to this; it does not own it.
//
// Ported from legacy/player.js. The behaviour pinned by
// test/legacy-player.test.ts is reproduced deliberately -- where a rule looks
// odd (previous restarting past four seconds, say) it is kept, because those
// tests exist to catch it changing.

import { clamp, formatTime } from '../lib/format.ts';
import { get, post } from '../api/client.ts';
import type { Continuation, Lyrics, ResolveResult, Track } from '../api/types.ts';

const STORAGE_KEY = 'music-taste-player-v1';
const OFFSETS_KEY = 'music-taste-lyric-offsets-v1';

/**
 * How far ahead the queue is kept, and how much played history is retained.
 *
 * The old engine let the queue grow to 500 and only trimmed once you were 100
 * tracks past the start, so a long autoplay session carried hundreds of rows
 * in memory, in localStorage and in the queue panel. Nothing needs that: what
 * is ahead of you is the only part that can still be played, and continuation
 * can always produce more.
 *
 * Explicitly queued tracks are never trimmed -- only played history behind the
 * cursor is, and only past HISTORY.
 */
const KEEP_AHEAD = 30;
const HISTORY = 10;

export interface QueueItem {
  id: string;
  name: string;
  artists: string;
  durationMs: number;
  albumId?: string | undefined;
  imageUrl?: string | undefined;
  continuationAlbumId?: string | undefined;
}

export type BarState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

/** Everything the UI renders from. Replaced wholesale on every change. */
export interface PlayerSnapshot {
  state: BarState;
  overline: string;
  title: string;
  /** Rendered as text; the album link is separate so React can build it. */
  byline: string;
  albumId: string;
  albumName: string;
  artUrl: string;
  artFallbackUrl: string;
  initial: string;
  radioSeedId: string | null;
  queue: QueueItem[];
  queueIndex: number;
  currentId: string | null;
  positionText: string;
  remainingText: string;
  progress: number;
  canScrub: boolean;
  canPlay: boolean;
  volumePosition: number;
  lyrics: Lyrics | null;
  lyricsTitle: string;
  lyricsSource: string;
  activeLine: number;
  activeWord: number;
  lyricOffset: number;
  wakeAvailable: boolean;
  toast: { message: string; bad: boolean; at: number } | null;
}

const EMPTY: PlayerSnapshot = {
  state: 'idle',
  overline: 'Local archive',
  title: 'Choose a track',
  byline: 'Play from your downloaded collection',
  albumId: '', albumName: '', artUrl: '', artFallbackUrl: '', initial: 'MT',
  radioSeedId: null,
  queue: [], queueIndex: -1, currentId: null,
  positionText: '0:00', remainingText: '−0:00', progress: 0,
  canScrub: false, canPlay: false, volumePosition: 0.72,
  lyrics: null, lyricsTitle: 'Nothing playing', lyricsSource: 'Lyrics',
  activeLine: -1, activeWord: -1, lyricOffset: 0,
  wakeAvailable: false, toast: null,
};

const artUrlFor = (albumId: string | null | undefined): string => {
  if (!albumId) return '';
  return /^(localalbum|libalbum)-/.test(albumId)
    ? `/img/local/${encodeURIComponent(albumId)}.jpg`
    : `/img/albums/${encodeURIComponent(albumId)}.jpg`;
};

class PlayerEngine {
  // Two elements. audioA is the one in the document; audioB never is.
  private readonly audioA: HTMLAudioElement;
  private readonly audioB: HTMLAudioElement;
  private audio: HTMLAudioElement;
  private prefetch: { trackId: string; ready: boolean; track: Track | null } | null = null;

  private queue: QueueItem[] = [];
  private queueIndex = -1;
  private current: Track | null = null;
  private pendingTrackId: string | null = null;
  private advancing = false;

  private continuationAlbums: string[] = [];
  private continuationEnabled = true;
  private continuationPromise: Promise<number> | null = null;
  private continuationStopped = false;
  private continuationRetryAt = 0;

  private playLog: { trackId: string; ms: number; lastT: number } | null = null;
  private pendingResume: { id: string; pos: number } | null = null;
  private lastPositionSave = 0;

  private lyricsData: Lyrics | null = null;
  private lyricsTrackId: string | null = null;
  private lyricsFetchToken = 0;
  private activeLine = -1;
  private activeWord = -1;
  private lyricsScrolledAt = 0;

  private snapshot: PlayerSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.audioA = new Audio();
    this.audioA.preload = 'metadata';
    this.audioB = new Audio();
    this.audioB.preload = 'auto';
    this.audio = this.audioA;

    for (const el of [this.audioA, this.audioB]) {
      el.addEventListener('play', (e) => { if (e.target === this.audio) this.onPlayState('playing'); });
      el.addEventListener('pause', (e) => { if (e.target === this.audio) this.onPlayState('paused'); });
      el.addEventListener('timeupdate', (e) => { if (e.target === this.audio) this.onTimeUpdate(); });
      el.addEventListener('durationchange', (e) => { if (e.target === this.audio) this.emit(); });
      el.addEventListener('ended', (e) => { if (e.target === this.audio) void this.next(); });
      el.addEventListener('error', (e) => {
        // A failed pre-buffer just falls back to the normal resolve path.
        if (e.target !== this.audio) { this.prefetch = null; return; }
        if (!this.audio.src) return;
        this.patch({ state: 'error', overline: 'Playback interrupted', byline: 'The local file could not be streamed' });
        this.notify('Playback stopped. The archive may have gone offline.', true);
      });
    }

    this.restore();
    this.installMediaSession();
    addEventListener('pagehide', () => { this.save(); this.flushPlay(false); });
  }

  // --- subscription -------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  getSnapshot = (): PlayerSnapshot => this.snapshot;

  private emit() {
    const duration = this.durationSeconds();
    this.snapshot = {
      ...this.snapshot,
      queue: this.queue,
      queueIndex: this.queueIndex,
      currentId: this.current?.id ?? null,
      positionText: formatTime(this.audio.currentTime),
      remainingText: `−${formatTime(Math.max(0, duration - this.audio.currentTime))}`,
      progress: duration ? this.audio.currentTime / duration : 0,
      volumePosition: Math.sqrt(clamp(this.audio.volume, 0, 1)),
      lyrics: this.lyricsData,
      activeLine: this.activeLine,
      activeWord: this.activeWord,
      lyricOffset: this.lyricShift(),
    };
    for (const fn of this.listeners) fn();
  }

  private patch(part: Partial<PlayerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...part };
    this.emit();
  }

  private durationSeconds(): number {
    return Number.isFinite(this.audio.duration)
      ? this.audio.duration
      : (this.current?.duration_ms ?? 0) / 1000;
  }

  // --- persistence --------------------------------------------------------

  private save() {
    try {
      const resume = this.current && this.audio.currentTime > 5
        ? { id: this.current.id, pos: Math.floor(this.audio.currentTime) }
        : this.pendingResume;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        queue: this.queue, queueIndex: this.queueIndex, volume: this.audio.volume,
        resume, continuationAlbums: this.continuationAlbums,
        continuationEnabled: this.continuationEnabled,
      }));
    } catch { /* private browsing can deny storage */ }
  }

  private restore() {
    let volume = 0.52;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
      const q = saved.queue;
      this.queue = Array.isArray(q)
        ? (q as QueueItem[]).filter((i) => i?.id).slice(0, KEEP_AHEAD + HISTORY)
        : [];
      const idx = saved.queueIndex;
      this.queueIndex = typeof idx === 'number' && Number.isInteger(idx) && idx < this.queue.length ? idx : -1;
      const albums = saved.continuationAlbums;
      this.continuationAlbums = Array.isArray(albums)
        ? (albums as string[]).filter((id) => /^libalbum-[a-f0-9]+$/.test(id)).slice(-200)
        : [];
      this.continuationEnabled = saved.continuationEnabled !== false;
      if (typeof saved.volume === 'number' && Number.isFinite(saved.volume)) volume = clamp(saved.volume, 0, 1);

      const item = this.queue[this.queueIndex];
      const resume = saved.resume as { id?: string; pos?: number } | undefined;
      if (resume?.id && item && resume.id === item.id && Number.isFinite(resume.pos)) {
        this.pendingResume = { id: resume.id, pos: resume.pos as number };
        this.snapshot = {
          ...this.snapshot,
          state: 'paused',
          overline: 'Pick up where you left off',
          title: item.name,
          byline: `${item.artists ? `${item.artists} · ` : ''}paused at ${formatTime(this.pendingResume.pos)}`,
          initial: (item.name || 'MT').slice(0, 1).toUpperCase(),
          canPlay: true,
        };
      }
    } catch { /* a corrupt blob is not worth failing the app over */ }
    this.audioA.volume = volume;
    this.audioB.volume = volume;
    this.emit();
  }

  // --- queue --------------------------------------------------------------

  /**
   * Drop played history beyond HISTORY, so a long autoplay session does not
   * accumulate hundreds of rows. Only touches what is BEHIND the cursor --
   * anything still ahead was either explicitly queued or is about to play.
   */
  private trim() {
    if (this.queueIndex <= HISTORY) return;
    const drop = this.queueIndex - HISTORY;
    this.queue = this.queue.slice(drop);
    this.queueIndex -= drop;
  }

  /** How many tracks are still ahead of the cursor. */
  private ahead(): number {
    return Math.max(0, this.queue.length - this.queueIndex - 1);
  }

  setQueue(tracks: QueueItem[], selectedId: string, keepPlayingAfterList = true) {
    const seen = new Set<string>();
    this.queue = tracks.filter((t) => t.id && !seen.has(t.id) && seen.add(t.id));
    this.queueIndex = Math.max(0, this.queue.findIndex((t) => t.id === selectedId));
    this.continuationAlbums = [];
    this.continuationEnabled = keepPlayingAfterList;
    this.continuationPromise = null;
    this.continuationStopped = false;
    this.continuationRetryAt = 0;
    this.save();
    this.emit();
  }

  /**
   * Add to the end without disturbing what is playing.
   *
   * Radio needs this: a track it fetched arrives minutes after the station
   * started, and rebuilding the queue from the page would restart playback.
   */
  append(tracks: QueueItem[], options: { allowPlayedDuplicates?: boolean } = {}): number {
    const compared = options.allowPlayedDuplicates ? this.queue.slice(this.queueIndex + 1) : this.queue;
    const known = new Set(compared.map((i) => i.id));
    const added = tracks.filter((t) => t.id && !known.has(t.id));
    if (!added.length) return 0;
    this.queue = this.queue.concat(added);
    this.trim();
    this.save();
    this.emit();
    return added.length;
  }

  has = (id: string): boolean => this.queue.some((i) => i.id === id);

  private rememberContinuationAlbum(id: string | null | undefined) {
    const albumId = String(id ?? '').trim();
    if (!/^libalbum-[a-f0-9]+$/.test(albumId)) return;
    this.continuationAlbums = this.continuationAlbums.filter((s) => s !== albumId).concat(albumId).slice(-200);
  }

  /** Grow an exhausted queue by one whole local album. */
  private appendContinuation(): Promise<number> {
    if (!this.continuationEnabled || this.continuationStopped || !this.current?.id
      || Date.now() < this.continuationRetryAt) {
      return Promise.resolve(0);
    }
    if (this.continuationPromise) return this.continuationPromise;
    this.continuationPromise = (async () => {
      const seedId = this.current!.id;
      try {
        const params = new URLSearchParams({ id: seedId, visited: this.continuationAlbums.join(',') });
        const data = await get<Continuation>(`/api/player/continuation?${params.toString()}`);
        if (this.current?.id !== seedId) return 0;
        if (!data.available || !Array.isArray(data.tracks) || !data.tracks.length) {
          this.continuationStopped = true;
          return 0;
        }
        if (data.reset) this.continuationAlbums = [];
        const added = this.append(data.tracks.map((t) => ({
          id: t.id,
          name: t.name || 'Unknown track',
          artists: t.artists ?? '',
          durationMs: Number(t.duration_ms ?? 0),
          albumId: t.album_id ?? data.album?.id ?? '',
          imageUrl: t.image_url ?? '',
          continuationAlbumId: t.continuation_album_id ?? data.album?.id ?? '',
        })), { allowPlayedDuplicates: Boolean(data.reset) });
        if (!added) { this.continuationStopped = true; return 0; }
        this.rememberContinuationAlbum(data.album?.id);
        const bridge = data.reason === 'same-artist' ? 'More from'
          : data.reason === 'same-vibe' ? 'Same vibe' : 'Next artist';
        if (data.album) this.notify(`${bridge}: ${data.album.name} — ${data.album.artists}`);
        return added;
      } catch {
        // A network wobble at a track boundary must not cause four retries a
        // second from timeupdate. The queue is intact; try again later.
        this.continuationRetryAt = Date.now() + 30_000;
        return 0;
      } finally {
        this.continuationPromise = null;
      }
    })();
    return this.continuationPromise;
  }

  // --- playback -----------------------------------------------------------

  async playAt(index: number): Promise<void> {
    if (!this.queue.length || index < 0 || index >= this.queue.length) return;
    this.flushPlay(false);
    this.prefetch = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.current = null;
    this.queueIndex = index;
    this.pendingTrackId = this.queue[index]!.id;
    this.trim();
    this.save();

    const item = this.queue[this.queueIndex]!;
    this.patch({
      state: 'loading', canPlay: false, canScrub: false, progress: 0,
      positionText: '0:00', remainingText: '−0:00',
      overline: 'Finding local file', title: item.name,
      byline: item.artists || 'Matching with Jellyfin…',
    });

    try {
      const result = await get<ResolveResult>(`/api/player/resolve?id=${encodeURIComponent(item.id)}`);
      if (this.pendingTrackId !== item.id) return;
      if (!result.available) { this.showUnavailable(result); return; }

      const track = result.track!;
      this.current = track;
      this.queue[this.queueIndex] = {
        ...item,
        name: track.name,
        artists: track.artists ?? '',
        durationMs: track.duration_ms ?? item.durationMs,
        albumId: track.album_id ?? item.albumId,
        imageUrl: track.image_url ?? item.imageUrl,
        continuationAlbumId: track.continuation_album_id ?? item.continuationAlbumId,
      };
      this.rememberContinuationAlbum(track.continuation_album_id);
      this.pendingTrackId = null;
      this.adoptTrack(track);
      this.audio.src = result.streamUrl!;
      this.startPlayLog(track.id);
      await this.audio.play();
      if (this.pendingResume?.id === track.id && this.pendingResume.pos > 0) {
        this.audio.currentTime = this.pendingResume.pos;
      }
      this.pendingResume = null;
      this.save();
      this.emit();
    } catch (err) {
      this.showUnavailable({
        available: false, reason: 'player-error',
        detail: err instanceof Error ? err.message : 'Playback could not start',
      });
    }
  }

  /** Everything that follows from "this track is now the current one". */
  private adoptTrack(track: Track) {
    const albumId = track.album_id ?? '';
    this.patch({
      state: 'loading',
      overline: 'Local archive · Jellyfin',
      title: track.name,
      byline: track.artists ?? '',
      albumId,
      albumName: track.album ?? '',
      artUrl: artUrlFor(albumId),
      artFallbackUrl: track.image_url ?? '',
      initial: (track.name || 'MT').slice(0, 1).toUpperCase(),
      radioSeedId: /^libtrack-/.test(track.id) ? track.id : null,
      canPlay: true,
      canScrub: true,
      wakeAvailable: false,
    });
    this.updateMediaSession(track);
    void this.loadLyrics(track);
  }

  /** ~20s before the end, resolve the next item into the standby element. */
  private async prefetchNext() {
    let upNext = this.queue[this.queueIndex + 1];
    if (!upNext) {
      await this.appendContinuation();
      upNext = this.queue[this.queueIndex + 1];
    }
    if (!upNext || this.prefetch?.trackId === upNext.id) return;
    this.prefetch = { trackId: upNext.id, ready: false, track: null };
    try {
      const result = await get<ResolveResult>(`/api/player/resolve?id=${encodeURIComponent(upNext.id)}`);
      if (this.prefetch?.trackId !== upNext.id || !result.available) return;
      const el = this.standby();
      el.src = result.streamUrl!;
      el.load();
      this.prefetch.track = result.track ?? null;
      this.prefetch.ready = true;
    } catch { /* fall back to the normal resolve path on ended */ }
  }

  private standby(): HTMLAudioElement {
    return this.audio === this.audioA ? this.audioB : this.audioA;
  }

  async next(): Promise<void> {
    if (this.advancing) return;
    this.advancing = true;
    try {
      this.flushPlay(true);
      let index = this.queueIndex + 1;
      if (index >= this.queue.length) {
        this.patch({ state: 'loading', overline: 'Finding what plays next', canPlay: false });
        await this.appendContinuation();
        index = this.queueIndex + 1;
        if (index >= this.queue.length) {
          this.audio.pause();
          this.audio.currentTime = 0;
          this.patch({ state: 'paused', overline: 'End of queue', canPlay: true });
          return;
        }
      }
      const item = this.queue[index]!;
      // The gapless path: swap which element is active instead of re-fetching.
      if (this.prefetch?.ready && this.prefetch.trackId === item.id && this.prefetch.track) {
        const old = this.audio;
        this.audio = this.standby();
        old.pause();
        old.removeAttribute('src');
        old.load();
        this.queueIndex = index;
        const track = this.prefetch.track;
        this.current = track;
        this.queue[index] = {
          ...item,
          name: track.name,
          artists: track.artists ?? item.artists,
          durationMs: track.duration_ms ?? item.durationMs,
          albumId: track.album_id ?? item.albumId,
          imageUrl: track.image_url ?? item.imageUrl,
          continuationAlbumId: track.continuation_album_id ?? item.continuationAlbumId,
        };
        this.rememberContinuationAlbum(track.continuation_album_id);
        this.pendingTrackId = null;
        this.prefetch = null;
        this.trim();
        this.adoptTrack(track);
        this.save();
        this.startPlayLog(track.id);
        this.audio.play().catch(() => { void this.playAt(index); });
        return;
      }
      await this.playAt(index);
    } finally {
      this.advancing = false;
    }
  }

  /**
   * Past four seconds, restart. Within them, step back.
   *
   * Pressing previous mid-song almost always means "play this again", not
   * "leave". Pinned by the characterisation tests.
   */
  previous() {
    if (this.audio.currentTime > 4) {
      this.audio.currentTime = 0;
      this.emit();
    } else if (this.queueIndex > 0) {
      void this.playAt(this.queueIndex - 1);
    }
  }

  toggle() {
    if (!this.audio.src && this.queueIndex >= 0) { void this.playAt(this.queueIndex); return; }
    if (this.audio.paused) this.audio.play().catch((e: Error) => this.notify(e.message, true));
    else this.audio.pause();
  }

  seekFraction(fraction: number) {
    if (!Number.isFinite(this.audio.duration)) return;
    this.audio.currentTime = clamp(fraction, 0, 1) * this.audio.duration;
    this.emit();
  }

  seekTo(seconds: number) {
    this.audio.currentTime = Math.max(0, seconds);
    this.lyricsScrolledAt = 0;
    this.syncLyrics(true);
  }

  setVolumePosition(position: number) {
    const gain = clamp(position, 0, 1) ** 2;
    this.audioA.volume = gain;
    this.audioB.volume = gain;
    this.save();
    this.emit();
  }

  private onPlayState(state: 'playing' | 'paused') {
    if (state === 'paused' && this.snapshot.state === 'error') return;
    this.patch({ state });
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }

  private onTimeUpdate() {
    this.tickPlayLog();
    const duration = this.durationSeconds();
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration, playbackRate: this.audio.playbackRate,
          position: Math.min(this.audio.currentTime, duration),
        });
      } catch { /* unsupported state */ }
    }
    // Only top up when the queue is running low, rather than on every boundary.
    if (duration && duration - this.audio.currentTime < 20 && !this.audio.paused) {
      if (this.ahead() < KEEP_AHEAD) void this.prefetchNext();
    }
    if (!this.audio.paused && Date.now() - this.lastPositionSave > 5000) {
      this.lastPositionSave = Date.now();
      this.save();
    }
    this.syncLyrics();
    this.emit();
  }

  private showUnavailable(result: ResolveResult) {
    this.patch({
      state: 'error',
      overline: result.reason === 'archive-offline' ? 'Archive asleep' : 'Unavailable locally',
      title: result.track?.name ?? this.queue[this.queueIndex]?.name ?? 'Cannot play this track',
      byline: result.reason === 'not-matched'
        ? 'Not in the library — getting it now'
        : result.detail ?? 'No local audio source is available',
      wakeAvailable: Boolean(result.wakeAvailable && result.reason === 'archive-offline'),
      lyrics: null, lyricsTitle: 'Nothing playing',
    });
    // Pressing play on a song we do not have IS the request for it.
    if (result.reason === 'not-matched' && result.track) void this.want(result.track);
    this.notify(result.detail ?? 'This track is not available in the local archive', true);
  }

  private async want(track: Track) {
    const artist = (track.artists ?? '').split(',')[0]?.trim();
    if (!artist || !track.name) return;
    try {
      const data = await post<{ detail?: string }>('/api/tracks/want', {
        artist, title: track.name, album: track.album ?? null, durationMs: track.duration_ms ?? null,
      });
      this.notify(data.detail ?? 'Fetching this track');
    } catch (err) {
      this.notify(err instanceof Error ? err.message : 'Could not queue it', true);
    }
  }

  async wake(): Promise<void> {
    this.notify('Wake signal sent. Waiting for the archive…');
    try {
      await post('/api/player/wake', {});
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await new Promise((r) => setTimeout(r, 3000));
        const status = await get<{ state: string }>('/api/player/status?refresh=1');
        if (status.state === 'ready') {
          this.notify('The archive is awake and ready');
          if (this.queueIndex >= 0) void this.playAt(this.queueIndex);
          return;
        }
      }
      this.notify('Eliot is taking longer than expected. Try again in a moment.', true);
    } catch (err) {
      this.notify(err instanceof Error ? err.message : 'Could not send the wake signal', true);
    }
  }

  // --- play logging -------------------------------------------------------

  private startPlayLog(trackId: string) { this.playLog = { trackId, ms: 0, lastT: 0 }; }

  private tickPlayLog() {
    if (!this.playLog) return;
    const t = this.audio.currentTime;
    const dt = t - this.playLog.lastT;
    // Seeks and element swaps produce big jumps; they are not listening time.
    if (dt > 0 && dt < 2) this.playLog.ms += dt * 1000;
    this.playLog.lastT = t;
  }

  private flushPlay(completed: boolean) {
    const log = this.playLog;
    this.playLog = null;
    if (!log || log.ms < 20000) return;
    const body = JSON.stringify({ id: log.trackId, msPlayed: Math.round(log.ms), completed });
    const sent = navigator.sendBeacon?.('/api/player/played', new Blob([body], { type: 'application/json' }));
    if (!sent) {
      fetch('/api/player/played', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true,
      }).catch(() => {});
    }
  }

  // --- lyrics -------------------------------------------------------------

  private lyricShift(): number {
    if (!this.lyricsTrackId) return 0;
    try {
      const offsets = JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? '{}') as Record<string, number>;
      const shift = offsets[this.lyricsTrackId];
      return Number.isFinite(shift) ? shift! : 0;
    } catch { return 0; }
  }

  nudgeLyrics(delta: number) {
    if (!this.lyricsTrackId) return;
    try {
      const offsets = JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? '{}') as Record<string, number>;
      offsets[this.lyricsTrackId] = Math.round(((offsets[this.lyricsTrackId] ?? 0) + delta) * 10) / 10;
      if (!offsets[this.lyricsTrackId]) delete offsets[this.lyricsTrackId];
      localStorage.setItem(OFFSETS_KEY, JSON.stringify(offsets));
    } catch { /* private browsing can deny storage */ }
    this.syncLyrics(true);
  }

  markLyricsScrolled() { this.lyricsScrolledAt = Date.now(); }
  /** Whether the panel may autoscroll, or the reader just moved it themselves. */
  mayAutoscroll(): boolean { return Date.now() - this.lyricsScrolledAt > 4000; }

  private async loadLyrics(track: Track) {
    this.lyricsData = null;
    this.lyricsTrackId = track.id;
    this.activeLine = -1;
    this.patch({ lyricsTitle: track.name, lyricsSource: 'Lyrics', lyrics: null });
    const token = ++this.lyricsFetchToken;
    try {
      const data = await get<Lyrics>(`/api/player/lyrics?id=${encodeURIComponent(track.id)}`);
      if (token !== this.lyricsFetchToken) return;
      this.lyricsData = data;
    } catch {
      if (token !== this.lyricsFetchToken) return;
      this.lyricsData = { available: false, synced: null, plain: null, instrumental: false, source: null };
    }
    const d = this.lyricsData;
    const wordly = d.synced?.some((l) => l.words?.length);
    this.patch({
      lyrics: d,
      lyricsSource: d.instrumental ? 'Instrumental'
        : d.synced?.length ? `${d.source === 'jellyfin' ? 'Synced · local library' : 'Synced · LRCLIB'}${wordly ? ' · word timing' : ''}`
        : d.plain ? (d.source === 'jellyfin' ? 'Unsynchronized · local library' : 'Unsynchronized · LRCLIB')
        : 'Lyrics',
    });
    this.syncLyrics(true);
  }

  private syncLyrics(force = false) {
    const lines = this.lyricsData?.synced;
    if (!lines?.length) return;
    const now = this.audio.currentTime;
    const shift = this.lyricShift();
    let index = -1;
    while (index + 1 < lines.length && lines[index + 1]!.time + shift <= now) index += 1;
    if (index === this.activeLine && !force) return;
    this.activeLine = index;
    this.activeWord = -1;

    // Word sweep, only when the source carried real word timing.
    const words = lines[index]?.words;
    if (words?.length) {
      let w = -1;
      while (w + 1 < words.length && words[w + 1]!.time + shift <= now) w += 1;
      this.activeWord = w;
    }
    this.emit();
  }

  // --- media session ------------------------------------------------------

  private updateMediaSession(track: Track) {
    if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return;
    const albumId = track.album_id ?? '';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist: track.artists ?? '',
      album: track.album ?? '',
      artwork: albumId ? [{ src: artUrlFor(albumId), sizes: '512x512', type: 'image/jpeg' }] : [],
    });
  }

  private installMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers: Record<string, MediaSessionActionHandler> = {
      play: () => { void this.audio.play(); },
      pause: () => this.audio.pause(),
      previoustrack: () => this.previous(),
      nexttrack: () => { void this.next(); },
      seekbackward: (d) => { this.audio.currentTime = Math.max(0, this.audio.currentTime - (d.seekOffset ?? 10)); },
      seekforward: (d) => { this.audio.currentTime = Math.min(this.audio.duration || Infinity, this.audio.currentTime + (d.seekOffset ?? 10)); },
      seekto: (d) => { if (d.seekTime != null) this.audio.currentTime = d.seekTime; },
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler); } catch { /* unsupported */ }
    }
  }

  // --- toast --------------------------------------------------------------

  notify(message: string, bad = false) {
    this.patch({ toast: { message, bad, at: Date.now() } });
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.patch({ toast: null }), 4200);
  }
}

/**
 * The singleton. Created on import, once per document.
 *
 * Not in a ref, not in state, not in a provider's constructor -- all of those
 * can run twice under Strict Mode, and two engines means two audio elements
 * playing over each other.
 */
export const player = new PlayerEngine();

// The station view appends fetched tracks from outside React's tree in the old
// UI. Kept on window so anything still doing that keeps working.
declare global {
  interface Window {
    musicQueueAppend?: (tracks: QueueItem[], options?: { allowPlayedDuplicates?: boolean }) => number;
    musicQueueHas?: (id: string) => boolean;
  }
}
window.musicQueueAppend = (tracks, options) => player.append(tracks, options ?? {});
window.musicQueueHas = (id) => player.has(id);
