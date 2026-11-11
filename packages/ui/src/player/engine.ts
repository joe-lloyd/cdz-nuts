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

import { OutputVolume, usesOutputVolume } from './outputVolume.ts';
import { clamp, formatTime } from '../lib/format.ts';
import {
  absoluteUrl, hasNativeHost, installNativeCommands, sendGone, sendNowPlaying,
} from './nativeBridge.ts';
import { ApiError, get, getFresh, post } from '../api/client.ts';
import type { Continuation, Lyrics, PlayerStatus, ResolveResult, Track } from '../api/types.ts';

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

/**
 * How long `next()` will refuse a second, overlapping advance.
 *
 * Long enough to cover a resolve and a track swap on a slow link, short
 * enough that a wedged advance cannot outlast the song it was trying to
 * leave. Only one `ended` fires per track, so the only thing this really has
 * to coalesce is that event racing an impatient click.
 */
const ADVANCE_GUARD_MS = 15_000;

/**
 * Ten milliseconds of silence to start the standby inside a user gesture.
 * The previous WAV had zero frames. WKWebView rejected it with a decode
 * error and left play() pending, so it could not grant playback permission.
 */
const SILENCE = 'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

/**
 * How long a swapped-in element gets to make a sound.
 *
 * The gapless swap plays an element that has been buffering in the
 * background for twenty seconds, so it should start at once. One that has not
 * moved after this long is not going to: its `play()` promise is the kind
 * that never settles, and nothing else will ever fire. Loading the track
 * afresh through the ordinary path is the same thing every first track does,
 * and that path is known to work.
 */
const SWAP_START_MS = 5000;

/**
 * Gapless handoff.
 *
 * Waiting for `ended` leaves a gap: the event lands a beat after the last
 * sample, and the incoming element then takes a moment to start producing
 * sound. So within the last HANDOFF_WINDOW_S the engine times the swap
 * itself, starting the next track the moment the current one runs out, less
 * the time an element takes to start. That start time is measured on every
 * swap and kept as a running average, so the lead fits this machine rather
 * than a guess. `ended` still advances if the timer never gets to run.
 */
const HANDOFF_WINDOW_S = 1.5;
const HANDOFF_LEAD_INITIAL_S = 0.05;
const HANDOFF_LEAD_MAX_S = 0.2;
/**
 * How far the file's own duration may differ from the scanned one before the
 * end is treated as unknown. An Ogg or Opus element only estimates its
 * duration, and timing the handoff off a guess would cut the song short; when
 * the two disagree, `ended` decides instead.
 */
const HANDOFF_DURATION_AGREEMENT_S = 0.25;

const RESUME_ATTEMPTS = 3;
/** Backoff between retries, multiplied by the attempt number. */
const RESUME_BACKOFF_MS = 1000;
/** Seconds of clean playback that count as recovered. */
const RESUME_SETTLED_S = 3;

/**
 * Watching for a track that is being fetched.
 *
 * Pressing play on a track we do not have queues it for download, and the bar
 * then waits on it. When it lands the bar says so and Play works; it does not
 * start by itself. The fetch takes seconds, but the sweep that runs it is on
 * a two-minute timer and Jellyfin has to index the file before it streams, so
 * the first few minutes are checked often and the rest slowly. A tray app left
 * on that track would otherwise sit on "getting it now" until it was restarted.
 */
const ARRIVAL_POLL_MS = 15_000;
const ARRIVAL_SLOW_POLL_MS = 60_000;
const ARRIVAL_FAST_FOR_MS = 5 * 60_000;
const ARRIVAL_GIVE_UP_MS = 60 * 60_000;

/**
 * Riding out a lost connection.
 *
 * Leaving the house moves a phone from home Wi-Fi to mobile data and the VPN
 * back home, and for that handover the server is simply unreachable. A track
 * that ended then could not resolve the next one, and the bar stopped dead
 * until someone pressed play. Now the player keeps asking whether the server
 * answers -- quickly at first, then every half minute, and at once when the
 * page comes back online or into view -- and carries on when it does.
 */
const NETWORK_RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000];
const NETWORK_GIVE_UP_MS = 15 * 60_000;
/** A request in flight during a handover can hang rather than fail. */
const RESOLVE_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 8_000;

const timeout = (ms: number): AbortSignal | null =>
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : null;

export interface QueueItem {
  id: string;
  name: string;
  artists: string;
  durationMs: number;
  albumId?: string | undefined;
  imageUrl?: string | undefined;
  continuationAlbumId?: string | undefined;
  recordingMbid?: string | null | undefined;
}

export type BarState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

/** Everything the UI renders from. Replaced wholesale on every change. */
export interface PlayerSnapshot {
  state: BarState;
  overline: string;
  title: string;
  /** Rendered as text; the artist and album links are separate so React can
      build them. Both ids are empty when there is no page to link to. */
  byline: string;
  artistId: string;
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
  canReconnect: boolean;
  volumePosition: number;
  lyrics: Lyrics | null;
  lyricsTitle: string;
  lyricsSource: string;
  activeLine: number;
  activeWord: number;
  lyricOffset: number;
  toast: { message: string; bad: boolean; at: number } | null;
}

const EMPTY: PlayerSnapshot = {
  state: 'idle',
  overline: 'Local archive',
  title: 'Choose a track',
  byline: 'Pick something to play',
  artistId: '', albumId: '', albumName: '', artUrl: '', artFallbackUrl: '', initial: 'MT',
  radioSeedId: null,
  queue: [], queueIndex: -1, currentId: null,
  positionText: '0:00', remainingText: '0:00', progress: 0,
  canScrub: false, canPlay: false, canReconnect: false, volumePosition: 0.72,
  lyrics: null, lyricsTitle: 'Nothing playing', lyricsSource: 'Lyrics',
  activeLine: -1, activeWord: -1, lyricOffset: 0,
  toast: null,
};

export const artUrlFor = (albumId: string | null | undefined): string => {
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
  private advancingUntil = 0;
  private playbackId = 0;

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
  private blessed = false;
  private outputVolume?: OutputVolume;
  private intentionallyPaused = false;
  private swapWatchdog: ReturnType<typeof setTimeout> | undefined;
  private handoffTimer: ReturnType<typeof setTimeout> | undefined;
  /** How long an incoming element takes to start sounding. See HANDOFF_WINDOW_S. */
  private handoffLead = HANDOFF_LEAD_INITIAL_S;
  /** Seconds the outgoing track still has to play when a timed handoff fires. */
  private handoffTail = 0;
  /** Ends the tail of a swapped-out element still playing, if there is one. */
  private stopTail: (() => void) | undefined;
  private resumeAttempts = 0;
  private resumeFrom = 0;
  /** A seek made while the stream was broken. See rememberSeek. */
  private seekTarget: number | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;
  private resumeCleanup: (() => void) | undefined;
  private arrivalTimer: ReturnType<typeof setTimeout> | undefined;
  /** A wait for the connection in progress: end it, or check right now. */
  private networkWait: { cleanup: () => void; now: () => void; trackId: string; at: number } | undefined;
  /** Tracks already asked for, so a re-check does not queue them twice. */
  private wanted = new Set<string>();

  constructor() {
    this.audioA = new Audio();
    this.audioB = new Audio();
    // Both elements buffer eagerly, and they must agree. `next()` alternates
    // which one is active, so whichever is on standby is the one prefetchNext
    // is loading the following track into -- if only one of them preloads,
    // then every other track is marked ready having fetched nothing but its
    // metadata, and the "gapless" swap lands on an element with no audio in
    // it. Same role each time round, so: same setting.
    this.audioA.preload = 'auto';
    this.audioB.preload = 'auto';
    this.audio = this.audioA;

    for (const el of [this.audioA, this.audioB]) {
      el.addEventListener('play', (e) => { if (e.target === this.audio) this.onPlayState('playing'); });
      el.addEventListener('pause', (e) => { if (e.target === this.audio) this.onPlayState('paused'); });
      el.addEventListener('timeupdate', (e) => { if (e.target === this.audio) this.onTimeUpdate(); });
      el.addEventListener('durationchange', (e) => { if (e.target === this.audio) this.emit(); });
      el.addEventListener('ended', (e) => { if (e.target === this.audio) void this.next(true); });
      el.addEventListener('error', (e) => {
        // A failed pre-buffer just falls back to the normal resolve path.
        if (e.target !== this.audio) { this.prefetch = null; return; }
        if (!this.audio.src || this.intentionallyPaused) return;
        if (this.resume()) return;
        // Out of quick retries. If the server is not even answering this is
        // the connection, not the file: wait for it rather than stop.
        const playbackId = this.playbackId;
        const at = this.breakPoint();
        void this.reachable().then((ok) => {
          if (this.playbackId !== playbackId || this.intentionallyPaused) return;
          if (!ok) { this.waitForNetwork(playbackId, at); return; }
          this.patch({ state: 'error', overline: 'Playback interrupted', byline: 'The local file could not be streamed', canReconnect: true });
          this.notify('Playback stopped. The archive may have gone offline.', true);
        });
      });
    }

    this.restore();
    if (usesOutputVolume()) {
      this.outputVolume = new OutputVolume(
        gain => { this.audioA.volume = gain; this.audioB.volume = gain; this.emit(); },
        name => {
          const playing = !this.audio.paused;
          const loading = this.snapshot.state === 'loading';
          this.pause();
          this.audioA.pause();
          this.audioB.pause();
          if (loading) this.patch({ state: 'paused', overline: 'Output changed', byline: 'Press play to continue', canPlay: true });
          if (playing) this.notify(`Audio output changed to ${name}. Press play to continue.`);
        },
        this.audio.volume,
        () => !this.audio.paused || this.snapshot.state === 'loading' ? this.audio.volume : null,
      );
      window.addEventListener('homearpa-audio-output', event => {
        this.outputVolume!.select((event as CustomEvent<unknown>).detail);
      });
      window.addEventListener('homearpa-audio-output-change', event => {
        this.outputVolume!.select((event as CustomEvent<unknown>).detail, true);
      });
      void this.outputVolume.load();
    }
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
      // Whole seconds on both sides, from the length the lists show, so the
      // two times always add up to it.
      remainingText: `−${formatTime(Math.max(0, Math.round(duration) - Math.floor(this.audio.currentTime)))}`,
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

  /**
   * How long the track really is.
   *
   * The element's own `duration` is a guess for Ogg and Opus: the container
   * carries no duration in its header, so a browser estimates one from the
   * bitrate and only corrects it if the tail is ever fetched -- which the
   * desktop proxy's range cap can stop happening at all. Drawn against that
   * guess, the bar ended before the song did: dragging to the end landed
   * short, and the remaining time hit zero while playback carried on.
   *
   * The scan knows the real length and sends it with the track, so that is
   * what the bar is drawn against. The element's figure is the fallback, for
   * anything the library has no duration for.
   */
  private durationSeconds(): number {
    const known = (this.current?.duration_ms ?? 0) / 1000;
    if (known > 0) return known;
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  // --- persistence --------------------------------------------------------

  private save() {
    try {
      const resume = this.current && this.audio.currentTime > 5
        ? { id: this.current.id, pos: Math.floor(this.audio.currentTime) }
        : this.pendingResume;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        queue: this.queue, queueIndex: this.queueIndex,
        volume: this.outputVolume?.legacyGain ?? this.audio.volume,
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
          recordingMbid: t.recording_mbid ?? null,
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

  /**
   * Start the queue item at `index`. `recovering` marks the engine's own
   * replays of a track that broke (Play after an error, the connection coming
   * back, Reconnect); only those keep the track's retry state.
   */
  async playAt(index: number, { recovering = false }: { recovering?: boolean } = {}): Promise<void> {
    if (!this.queue.length || index < 0 || index >= this.queue.length) return;
    this.intentionallyPaused = false;
    this.cancelResume();
    this.stopTail?.();
    clearTimeout(this.arrivalTimer);
    // Retry state belongs to one break in one track. A recovery replay keeps
    // it; anything else, including choosing the current track again, is a
    // fresh start and must not seek to where the last attempt broke.
    if (!recovering || this.queue[index]!.id !== this.current?.id) this.resetRetries();
    // A fresh start plays from the top, even if a pause or a saved session
    // left a place to pick up from. Play on the bar is the recovering path.
    if (!recovering) this.pendingResume = null;
    // Any held seek has been read into pendingResume by now.
    this.seekTarget = null;
    const playbackId = ++this.playbackId;
    this.bless();
    this.flushPlay(false);
    this.prefetch = null;
    clearTimeout(this.swapWatchdog);
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
      canReconnect: false,
      positionText: '0:00', remainingText: '−0:00',
      overline: 'Finding local file', title: item.name,
      byline: item.artists || 'Matching with Jellyfin…',
    });

    try {
      const result = await getFresh<ResolveResult>(
        `/api/player/resolve?id=${encodeURIComponent(item.id)}`, { signal: timeout(RESOLVE_TIMEOUT_MS) },
      );
      if (this.playbackId !== playbackId) return;
      if (!result.available) {
        this.showUnavailable(result);
        if (result.reason === 'not-matched') this.watchForArrival(item.id, playbackId);
        return;
      }

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
        recordingMbid: track.recording_mbid ?? item.recordingMbid,
      };
      this.rememberContinuationAlbum(track.continuation_album_id);
      this.pendingTrackId = null;
      this.adoptTrack(track);
      this.audio.src = result.streamUrl!;
      this.startPlayLog(track.id);
      await this.audio.play();
      if (this.playbackId !== playbackId) return;
      if (this.pendingResume?.id === track.id && this.pendingResume.pos > 0) {
        this.audio.currentTime = this.pendingResume.pos;
      }
      this.pendingResume = null;
      this.save();
      this.emit();
    } catch (err) {
      if (this.playbackId !== playbackId) return;
      // A blocked autoplay is a real answer; anything else may be the network.
      const blocked = err instanceof DOMException && err.name === 'NotAllowedError';
      if (!blocked && !this.intentionallyPaused && !(await this.reachable())) {
        if (this.playbackId === playbackId && !this.intentionallyPaused) this.waitForNetwork(playbackId, 0);
        return;
      }
      if (this.playbackId !== playbackId) return;
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
      overline: 'Local archive',
      title: track.name,
      byline: track.artists ?? '',
      artistId: track.artist_id ?? '',
      albumId,
      // The album page's own name, not the file's album tag. "The 78" is
      // tagged `Harmony Korine` but sits on the Singles shelf, so labelling
      // the link with the tag pointed it somewhere it did not say.
      albumName: track.album_name || track.album || '',
      artUrl: artUrlFor(albumId),
      artFallbackUrl: track.image_url ?? '',
      initial: (track.name || 'MT').slice(0, 1).toUpperCase(),
      radioSeedId: track.id || null,
      canPlay: true,
      canScrub: true,
      canReconnect: false,
    });
    this.updateMediaSession(track);
    this.pushNowPlaying();
    void this.loadLyrics(track);
  }

  /**
   * Time the swap to the next track so it starts as this one ends. Called on
   * every timeupdate; each call replaces the timer with a better-informed
   * one, and anything that moves away from the end (a seek back, a pause, a
   * new track) leaves no timer behind.
   */
  private scheduleHandoff() {
    this.cancelHandoff();
    const el = this.audio;
    if (el.paused || this.intentionallyPaused || !this.prefetch?.ready) return;
    if (this.prefetch.trackId !== this.queue[this.queueIndex + 1]?.id) return;
    const left = this.secondsLeft(el);
    if (left === null || left > HANDOFF_WINDOW_S) return;
    const playbackId = this.playbackId;
    this.handoffTimer = setTimeout(() => {
      this.handoffTimer = undefined;
      if (this.playbackId !== playbackId || this.audio !== el || el.paused || this.intentionallyPaused) return;
      // The standby may have failed since: then there is nothing to hand
      // over to, and `ended` takes the ordinary path at the real end.
      if (!this.prefetch?.ready || this.prefetch.trackId !== this.queue[this.queueIndex + 1]?.id) return;
      // Read the position again: a seek back may have landed since the timer
      // was set, and then there is more of this track to hear.
      const now = this.secondsLeft(el);
      if (now === null || now > left + 0.1) return;
      this.handoffTail = now;
      void this.next(true);
    }, Math.max(0, (left - this.handoffLead) * 1000));
  }

  private cancelHandoff() {
    clearTimeout(this.handoffTimer);
    this.handoffTimer = undefined;
  }

  /**
   * Real seconds of audio left in `el`, or null when the end is not known
   * well enough to time a handoff against. The scanned length and the file's
   * own figure have to agree; see HANDOFF_DURATION_AGREEMENT_S.
   */
  private secondsLeft(el: HTMLAudioElement): number | null {
    const scanned = (this.current?.duration_ms ?? 0) / 1000;
    const own = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    if (!scanned || !own || Math.abs(scanned - own) > HANDOFF_DURATION_AGREEMENT_S) return null;
    return (Math.min(scanned, own) - el.currentTime) / (el.playbackRate || 1);
  }

  /**
   * Let a swapped-out element play its last moments under the incoming one,
   * then retire it. Retiring at once would cut that tail and leave the
   * incoming element's start-up time silent. It goes on its own `ended`, or
   * shortly after it should have, whichever is first -- unless it has been
   * taken back or given another track in the meantime.
   */
  private retireAfterTail(el: HTMLAudioElement, tail: number) {
    const src = el.src;
    let done = false;
    const retire = () => {
      if (done) return;
      done = true;
      el.removeEventListener('ended', retire);
      clearTimeout(timer);
      if (this.stopTail === retire) this.stopTail = undefined;
      if (el === this.audio || el.src !== src) return;
      el.pause();
      el.removeAttribute('src');
      el.load();
    };
    // Pause, Next or a new track stop it at once: sound must never carry on
    // under a player that says it has stopped.
    this.stopTail?.();
    this.stopTail = retire;
    el.addEventListener('ended', retire);
    const timer = setTimeout(retire, (tail + 0.5) * 1000);
  }

  /** Learn how long a swapped-in element takes to start. See HANDOFF_WINDOW_S. */
  private measureStart(el: HTMLAudioElement, playbackId: number) {
    const started = performance.now();
    const onPlaying = () => {
      el.removeEventListener('playing', onPlaying);
      if (this.playbackId !== playbackId) return;
      const took = (performance.now() - started) / 1000;
      this.handoffLead = clamp(this.handoffLead * 0.7 + took * 0.3, 0, HANDOFF_LEAD_MAX_S);
    };
    el.addEventListener('playing', onPlaying);
  }

  /** ~20s before the end, resolve the next item into the standby element. */
  private async prefetchNext() {
    // The standby is still playing out the last track's tail. Loading into it
    // would cut that off; the next timeupdate after it retires tries again.
    if (this.stopTail) return;
    let upNext = this.queue[this.queueIndex + 1];
    if (!upNext) {
      await this.appendContinuation();
      upNext = this.queue[this.queueIndex + 1];
    }
    // A handoff may have happened while the queue was being topped up, and
    // left a tail playing in the standby.
    if (this.stopTail || !upNext || this.prefetch?.trackId === upNext.id) return;
    this.prefetch = { trackId: upNext.id, ready: false, track: null };
    try {
      const result = await get<ResolveResult>(`/api/player/resolve?id=${encodeURIComponent(upNext.id)}`);
      if (this.prefetch?.trackId !== upNext.id || !result.available) return;
      if (this.stopTail) {
        // Same again, during the resolve. Leave it to be retried once the
        // tail has finished, rather than marked as tried.
        this.prefetch = null;
        return;
      }
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

  /** Give the standby element its one chance to become playable. See SILENCE. */
  private bless() {
    if (this.blessed) return;
    this.blessed = true;
    const el = this.standby();
    if (el.src) return;
    // Keep it unmuted so this grants permission for audible playback too.
    const done = () => {
      // Only if it is still ours. Prefetch may have moved a real track in by
      // the time a slow promise gets round to settling.
      if (el.src !== SILENCE) return;
      el.pause();
      el.removeAttribute('src');
      el.load();
    };
    el.src = SILENCE;
    void Promise.resolve(el.play()).then(done, done);
  }

  async next(automatic = false): Promise<void> {
    // Only the timed handoff sets this, immediately before calling here.
    const tail = this.handoffTail;
    this.handoffTail = 0;
    this.cancelHandoff();
    // The standby may still be finishing the track before this one; it is
    // about to be needed, so it stops now.
    this.stopTail?.();
    if (automatic && this.intentionallyPaused) return;
    // A re-entrancy guard, deliberately not a lock: it must never be able to
    // outlive the advance it is guarding.
    //
    // All it has to absorb is `ended` and the Next button landing within a
    // few hundred milliseconds of each other. A boolean set here and cleared
    // in `finally` does that, but it also stays set forever if anything in
    // between never settles -- and a `play()` promise on a starved media
    // element does exactly that: it neither resolves nor rejects. One stalled
    // track would then silently kill auto-advance, the Next button AND the
    // media keys for the rest of the document's life. A browser tab gets
    // reloaded often enough to hide that; the tray app runs for days.
    if (Date.now() < this.advancingUntil) return;
    if (!automatic) this.intentionallyPaused = false;
    this.advancingUntil = Date.now() + ADVANCE_GUARD_MS;
    const advancePlaybackId = this.playbackId;
    try {
      this.flushPlay(true);
      let index = this.queueIndex + 1;
      if (index >= this.queue.length) {
        this.patch({ state: 'loading', overline: 'Finding what plays next', canPlay: false });
        await this.appendContinuation();
        if (this.playbackId !== advancePlaybackId) return;
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
        const playbackId = ++this.playbackId;
        this.resetRetries();
        const old = this.audio;
        this.audio = this.standby();
        if (tail > 0) {
          this.retireAfterTail(old, tail);
        } else {
          old.pause();
          old.removeAttribute('src');
          old.load();
        }
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
        recordingMbid: track.recording_mbid ?? item.recordingMbid,
        };
        this.rememberContinuationAlbum(track.continuation_album_id);
        this.pendingTrackId = null;
        this.prefetch = null;
        this.trim();
        this.adoptTrack(track);
        this.save();
        this.startPlayLog(track.id);
        const incoming = this.audio;
        const retry = () => {
          if (this.playbackId !== playbackId) return;
          clearTimeout(this.swapWatchdog);
          incoming.pause();
          incoming.removeAttribute('src');
          incoming.load();
          this.audio = old;
          // trim() may have moved the cursor since we computed index.
          void this.playAt(this.queueIndex);
        };
        clearTimeout(this.swapWatchdog);
        this.swapWatchdog = setTimeout(() => {
          if (incoming.currentTime === 0) retry();
        }, SWAP_START_MS);
        this.measureStart(incoming, playbackId);
        this.audio.play().catch(retry);
        return;
      }
      await this.playAt(index);
    } finally {
      this.advancingUntil = 0;
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
      this.cancelHandoff();
      this.audio.currentTime = 0;
      this.emit();
    } else if (this.queueIndex > 0) {
      void this.playAt(this.queueIndex - 1);
    }
  }

  toggle() {
    // A failed stream can leave the element claiming to play. While waiting
    // for the connection, or showing an error, the button is Play.
    if (this.networkWait || this.snapshot.state === 'error' || this.audio.paused || this.intentionallyPaused) this.requestPlay();
    else this.pause();
  }

  /** Only an explicit Play request releases a deliberate pause, including media keys. */
  private requestPlay() {
    this.intentionallyPaused = false;
    this.bless();
    if (this.networkWait) { this.networkWait.now(); return; }
    if ((!this.audio.src || this.audio.error) && this.queueIndex >= 0) {
      // After a failed retry the element was reloaded to zero; the break point
      // still knows where the track actually stopped.
      const at = this.breakPoint();
      if (this.audio.error && this.current && at > 0) {
        this.pendingResume = { id: this.current.id, pos: at };
      }
      void this.playAt(this.queueIndex, { recovering: true });
      return;
    }
    this.audio.play().catch((e: Error) => this.notify(e.message, true));
  }

  private pause() {
    const wait = this.networkWait;
    this.cancelHandoff();
    this.stopTail?.();
    this.intentionallyPaused = true;
    ++this.playbackId;
    this.cancelResume();
    clearTimeout(this.swapWatchdog);
    this.audio.pause();
    if (wait) {
      // The element is already paused, so no pause event will redraw the bar.
      // Drop the dead stream so Play resolves the track afresh, from where it
      // stopped.
      if (wait.at > 0) this.pendingResume = { id: wait.trackId, pos: wait.at };
      this.audio.removeAttribute('src');
      this.audio.load();
      this.patch({ state: 'paused', overline: 'Paused', byline: 'Lost the connection — press play to try again', canPlay: true });
    }
  }

  seekFraction(fraction: number) {
    // The same duration the bar is drawn against, or the two disagree and the
    // handle lands somewhere other than where it was dropped.
    const duration = this.durationSeconds();
    if (!duration) return;
    this.pendingResume = null;
    this.cancelHandoff();
    const target = clamp(fraction, 0, 1) * duration;
    this.rememberSeek(target);
    this.audio.currentTime = target;
    this.emit();
  }

  seekTo(seconds: number) {
    this.pendingResume = null;
    this.cancelHandoff();
    const target = Math.max(0, seconds);
    this.rememberSeek(target);
    this.audio.currentTime = target;
    this.lyricsScrolledAt = 0;
    this.syncLyrics(true);
  }

  setVolumePosition(position: number) {
    const gain = clamp(position, 0, 1) ** 2;
    this.audioA.volume = gain;
    this.audioB.volume = gain;
    this.outputVolume?.remember(gain);
    this.save();
    this.emit();
  }

  /**
   * Pick the track back up where it stopped, after a failed stream request.
   *
   * The media element treats any failed range request as the end of the road:
   * it fires `error` once and stays dead. That made every transient blip
   * terminal. On 2026-09-10 four requests got a 502 during a redeploy and each
   * one ended the song, which is how this was found.
   *
   * The same URL and a seek back to where it stopped is all it takes, because
   * the server answers ranges properly -- the retry asks for the bytes from
   * that offset, not the whole file again. Bounded attempts, because a stream
   * that is genuinely gone must still end up saying so rather than retrying
   * silently for ever.
   *
   * Returns whether a retry was scheduled.
   */
  /**
   * A seek is where the listener wants to be, so a retry or a connection wait
   * that later replays the track goes there, not to where it last broke.
   */
  private rememberSeek(target: number) {
    if (this.resumeAttempts > 0) this.resumeFrom = target;
    if (this.networkWait) this.networkWait.at = target;
    // A broken element may ignore the seek and go on reporting where it
    // died, so its currentTime cannot be trusted to carry the seek. Hold the
    // target itself until a replay uses it. A live element honours the seek
    // on its own, so nothing is held for one.
    const broken = Boolean(this.networkWait) || this.snapshot.state === 'error'
      || (this.snapshot.state === 'loading' && this.resumeAttempts > 0);
    if (broken) this.seekTarget = target;
  }

  private resetRetries() {
    this.resumeAttempts = 0;
    this.resumeFrom = 0;
    this.seekTarget = null;
  }

  /**
   * Where the current blip interrupted the track. A retry that fails before
   * its seek lands has been reloaded to zero, so within one blip the furthest
   * point reached wins; otherwise a second failure would restart the song.
   */
  private breakPoint(): number {
    if (this.seekTarget !== null) return this.seekTarget;
    const now = this.audio.currentTime;
    return this.resumeAttempts > 0 ? Math.max(now, this.resumeFrom) : now;
  }

  private resume(): boolean {
    const src = this.audio.src;
    if (this.intentionallyPaused || !src || this.resumeAttempts >= RESUME_ATTEMPTS) return false;

    const at = this.breakPoint();
    this.seekTarget = null; // now carried by resumeFrom
    const element = this.audio;
    this.resumeAttempts += 1;
    this.resumeFrom = at;

    this.patch({
      state: 'loading',
      overline: 'Reconnecting',
      byline: `Picking up where it stopped, attempt ${this.resumeAttempts} of ${RESUME_ATTEMPTS}`,
    });

    this.cancelResume();
    const playbackId = this.playbackId;
    this.resumeTimer = setTimeout(() => {
      if (this.playbackId !== playbackId || element !== this.audio) return;
      // Seek only once the element knows the track again: setting currentTime
      // on an element with no metadata is either ignored or throws.
      const seek = () => {
        cleanup();
        if (this.resumeCleanup === cleanup) this.resumeCleanup = undefined;
        if (this.playbackId !== playbackId || element !== this.audio) return;
        element.currentTime = at;
        void element.play();
      };
      const cleanup = () => element.removeEventListener('loadedmetadata', seek);
      this.resumeCleanup = cleanup;
      element.addEventListener('loadedmetadata', seek);
      element.src = src;
      element.load();
    }, RESUME_BACKOFF_MS * this.resumeAttempts);

    return true;
  }

  /** A deliberate pause or new track invalidates pending network-recovery playback. */
  private cancelResume() {
    this.networkWait?.cleanup();
    clearTimeout(this.resumeTimer);
    this.resumeCleanup?.();
    this.resumeCleanup = undefined;
  }

  /**
   * Whether the server answers at all. Any reply below 500 counts: the box is
   * there, whatever it thinks of the request. A 5xx is the proxy in front of
   * a server that is restarting, which is worth waiting out too.
   */
  private async reachable(): Promise<boolean> {
    try {
      await getFresh<PlayerStatus>('/api/player/status', { signal: timeout(PROBE_TIMEOUT_MS) });
      return true;
    } catch (err) {
      return err instanceof ApiError && err.status < 500;
    }
  }

  /**
   * Hold the current track until the server can be reached again, then play
   * it from `at` seconds. See NETWORK_RETRY_MS.
   *
   * Tied to the playback that lost the connection: pausing or choosing
   * another track ends the wait, and pressing play retries at once.
   */
  private waitForNetwork(playbackId: number, at: number) {
    this.cancelResume();
    const item = this.queue[this.queueIndex];
    if (!item) return;
    const startedAt = Date.now();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let probing = false;
    // A press that lands while a probe is out gets its own check afterwards.
    let pressedDuringProbe = false;

    const live = () => this.playbackId === playbackId && !this.intentionallyPaused
      && this.queue[this.queueIndex]?.id === item.id;
    const check = async (pressed = false) => {
      if (!live()) { cleanup(); return; }
      if (probing) { pressedDuringProbe ||= pressed; return; }
      probing = true;
      clearTimeout(timer);
      const ok = await this.reachable();
      probing = false;
      if (!live()) { cleanup(); return; }
      if (ok) {
        cleanup();
        this.resumeAttempts = 0;
        if (wait.at > 0) this.pendingResume = { id: item.id, pos: wait.at };
        this.notify('Back online');
        void this.playAt(this.queueIndex, { recovering: true });
        return;
      }
      if (pressedDuringProbe) { pressedDuringProbe = false; void check(true); return; }
      if (pressed) this.notify('Still cannot reach the library', true);
      if (Date.now() - startedAt >= NETWORK_GIVE_UP_MS) {
        cleanup();
        this.patch({
          state: 'error', overline: 'Playback interrupted',
          byline: 'Could not reach the library — press play to try again',
          canPlay: true, canReconnect: true,
        });
        return;
      }
      schedule();
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void check(), NETWORK_RETRY_MS[Math.min(attempt++, NETWORK_RETRY_MS.length - 1)]);
    };
    // The connection coming back, or the app being opened, is worth a check
    // straight away instead of at the next backoff step.
    const nudge = () => { if (document.visibilityState === 'visible') void check(); };
    const cleanup = () => {
      clearTimeout(timer);
      removeEventListener('online', nudge);
      document.removeEventListener('visibilitychange', nudge);
      if (this.networkWait === wait) this.networkWait = undefined;
    };
    const wait = { cleanup, now: () => void check(true), trackId: item.id, at };
    this.networkWait = wait;
    addEventListener('online', nudge);
    document.addEventListener('visibilitychange', nudge);

    this.patch({
      state: 'loading', overline: 'Waiting for the connection',
      byline: 'Carries on as soon as the library is reachable again',
      // Play checks again now rather than at the next step. On the desktop,
      // Reconnect rebuilds the tunnel, which may be exactly what is down.
      canPlay: true, canReconnect: true,
    });
    schedule();
  }

  private onPlayState(state: 'playing' | 'paused') {
    if (state === 'playing' && this.intentionallyPaused) { this.audio.pause(); return; }
    if (state === 'paused' && this.snapshot.state === 'error') return;
    this.patch({ state });
    this.pushNowPlaying();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }

  private onTimeUpdate() {
    // Past the point it broke at, so the next blip gets its own full budget
    // rather than inheriting the last one's.
    if (this.resumeAttempts && this.audio.currentTime > this.resumeFrom + RESUME_SETTLED_S) {
      this.resumeAttempts = 0;
    }
    this.tickPlayLog();
    this.pushNowPlaying();
    const duration = this.durationSeconds();
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration, playbackRate: this.audio.playbackRate,
          position: Math.min(this.audio.currentTime, duration),
        });
      } catch { /* unsupported state */ }
    }
    // Always have the next track buffered by the last twenty seconds. This
    // used to run only while fewer than KEEP_AHEAD tracks were queued, which
    // is the rule for topping the queue up, not for buffering: any long album,
    // playlist or station then loaded every next track cold, a second of
    // silence at each boundary. prefetchNext tops up itself when nothing is
    // queued next, and is a no-op once the next track is in.
    if (duration && duration - this.audio.currentTime < 20 && !this.audio.paused) {
      void this.prefetchNext();
    }
    this.scheduleHandoff();
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
      // Play on a missing track checks for it again rather than doing nothing.
      canPlay: result.reason === 'not-matched',
      canReconnect: result.reason === 'archive-offline' || result.reason === 'player-error',
      lyrics: null, lyricsTitle: 'Nothing playing',
    });
    // Pressing play on a song we do not have IS the request for it.
    if (result.reason === 'not-matched' && result.track) void this.want(result.track);
    this.notify(result.detail ?? 'This track is not available in the local archive', true);
  }

  private async want(track: Track) {
    const artist = (track.artists ?? '').split(',')[0]?.trim();
    if (!artist || !track.name || this.wanted.has(track.id)) return;
    this.wanted.add(track.id);
    try {
      const data = await post<{ detail?: string }>('/api/tracks/want', {
        artist, title: track.name, album: track.album ?? null, durationMs: track.duration_ms ?? null,
      });
      this.notify(data.detail ?? 'Fetching this track');
    } catch (err) {
      this.wanted.delete(track.id);
      this.notify(err instanceof Error ? err.message : 'Could not queue it', true);
    }
  }

  /**
   * Keep checking a missing track and mark it ready the moment it resolves.
   *
   * Only says so; it never starts playback, so it can never cut into
   * anything. Tied to the playback that found it missing: picking another
   * track, or pressing play to check by hand, starts a new playback and ends
   * this one, and that new playback resolves the track afresh anyway.
   */
  private watchForArrival(trackId: string, playbackId: number) {
    clearTimeout(this.arrivalTimer);
    const startedAt = Date.now();
    const schedule = () => {
      const waited = Date.now() - startedAt;
      if (waited >= ARRIVAL_GIVE_UP_MS) {
        this.patch({ byline: 'Still not in the library — press play to check again' });
        return;
      }
      this.arrivalTimer = setTimeout(check, waited < ARRIVAL_FAST_FOR_MS ? ARRIVAL_POLL_MS : ARRIVAL_SLOW_POLL_MS);
    };
    const ours = () => this.playbackId === playbackId && this.queue[this.queueIndex]?.id === trackId;
    const check = async () => {
      if (!ours()) return;
      try {
        const result = await getFresh<ResolveResult>(
          `/api/player/resolve?id=${encodeURIComponent(trackId)}`, { signal: timeout(RESOLVE_TIMEOUT_MS) },
        );
        if (!ours()) return;
        if (result.available) {
          this.wanted.delete(trackId);
          // Play goes through requestPlay, which resolves it again and plays.
          this.patch({
            state: 'paused', overline: 'Ready', byline: 'In the library now — press play',
            canPlay: true, canReconnect: false,
          });
          this.notify(`${result.track?.name ?? 'The track'} is ready to play`);
          return;
        }
      } catch { /* the server or tunnel wobbled; keep waiting */ }
      // The request may have failed after the listener moved on.
      if (!ours()) return;
      schedule();
    };
    schedule();
  }

  async reconnect(): Promise<void> {
    const playbackId = this.playbackId;
    this.notify('Reconnecting to the library…');
    try {
      await post('/api/desktop/reconnect', {});
      const status = await get<PlayerStatus>('/api/player/status?refresh=1');
      if (status.state !== 'ready') {
        this.notify(status.detail || 'The library is still unavailable', true);
        return;
      }
      this.notify('Connected to the library');
      // A wait for the connection carries on from where it stopped by itself.
      if (this.networkWait && this.playbackId === playbackId) { this.networkWait.now(); return; }
      if (this.queueIndex >= 0 && this.snapshot.state === 'error'
        && !this.intentionallyPaused && this.playbackId === playbackId) {
        const item = this.queue[this.queueIndex]!;
        const pos = this.audio.currentTime || this.resumeFrom;
        if (pos > 0) this.pendingResume = { id: item.id, pos };
        clearTimeout(this.resumeTimer);
        this.resumeAttempts = 0;
        void this.playAt(this.queueIndex, { recovering: true });
      }
    } catch (err) {
      this.notify(err instanceof Error ? err.message : 'Could not reconnect to the library', true);
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
    try {
      if (navigator.sendBeacon?.('/api/player/played', new Blob([body], { type: 'application/json' }))) return;
    } catch {
      // WKWebView rejects beacons to homelab:// with a synchronous TypeError.
      // The desktop protocol supports fetch, so report through it instead.
    }
    fetch('/api/player/played', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true,
    }).catch(() => {});
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
        : d.synced?.length ? `${d.source === 'jellyfin' ? 'Synced lyrics · your library' : 'Synced lyrics · LRCLIB'}${wordly ? ' · word by word' : ''}`
        : d.plain ? (d.source === 'jellyfin' ? 'Lyrics · your library' : 'Lyrics · LRCLIB')
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
    // One table, two callers. The browser gets these as MediaSession action
    // handlers; the phone app's host calls the same entries by name when a
    // lock-screen button is pressed. Sharing them is what stops the lock
    // screen and the media keys ever disagreeing about what "next" means --
    // `previous`, in particular, restarts the track within its first four
    // seconds, and that rule should not exist twice.
    const handlers: Record<string, MediaSessionActionHandler> = {
      play: () => this.requestPlay(),
      pause: () => this.pause(),
      previoustrack: () => this.previous(),
      nexttrack: () => { void this.next(); },
      seekbackward: (d) => this.seekTo(this.audio.currentTime - (d.seekOffset ?? 10)),
      seekforward: (d) => this.seekTo(Math.min(this.audio.duration || Infinity, this.audio.currentTime + (d.seekOffset ?? 10))),
      seekto: (d) => { if (d.seekTime != null) this.seekTo(d.seekTime); },
    };
    installNativeCommands(handlers);
    if (!('mediaSession' in navigator)) return;
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler); } catch { /* unsupported */ }
    }
  }

  /**
   * Mirror what the OS is being told to the native host as well.
   *
   * Fed from the same three moments that drive `mediaSession` -- new track,
   * play/pause, position tick -- so the notification cannot describe something
   * the browser session does not.
   */
  private pushNowPlaying() {
    if (!hasNativeHost()) return;
    const track = this.current;
    if (!track) { sendGone(); return; }
    const duration = this.durationSeconds();
    sendNowPlaying({
      title: track.name,
      artist: track.artists ?? '',
      album: this.snapshot.albumName || (track.album ?? ''),
      artworkUrl: absoluteUrl(this.snapshot.artUrl || artUrlFor(track.album_id ?? '')),
      playing: !this.audio.paused,
      positionSec: this.audio.currentTime,
      durationSec: duration,
      canNext: true,
      // Matches `previous()`: past four seconds it restarts rather than
      // stepping back, so the button is never a no-op.
      canPrevious: this.queueIndex > 0 || this.audio.currentTime > 4,
    });
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
