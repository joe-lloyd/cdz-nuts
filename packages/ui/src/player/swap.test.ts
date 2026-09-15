// The bug this pins: on macOS the queue moved to the next track and nothing
// played. The gapless swap hands playback to the standby element, and two
// things could leave that element useless without any event saying so: the
// silent sample that primes it left it muted when WebKit never settled the
// play() promise, and a play() that neither resolves nor rejects left the
// engine waiting for ever. Neither may cost the listener the track.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

type Listener = (event: { target: unknown }) => void;

class FakeAudio {
  preload = '';
  src = '';
  muted = false;
  currentTime = 0;
  duration = 210;
  paused = true;
  volume = 1;
  playbackRate = 1;
  loads = 0;
  playResult: Promise<void> | null = null;
  private listeners = new Map<string, Listener[]>();

  load() { this.loads += 1; this.currentTime = 0; }
  pause() { this.paused = true; }
  play(): Promise<void> {
    this.paused = false;
    // WebKit on media it will not decode: the promise never settles.
    if (this.src.startsWith('data:')) return new Promise(() => {});
    return this.playResult ?? Promise.resolve();
  }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ target: this });
  }
}

const created: FakeAudio[] = [];
const mediaHandlers = new Map<string, MediaSessionActionHandler>();
Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: {
  setActionHandler: (action: string, handler: MediaSessionActionHandler) => mediaHandlers.set(action, handler),
} });
vi.stubGlobal('Audio', class extends FakeAudio {
  constructor() { super(); created.push(this); }
});
const resolves: string[] = [];
vi.stubGlobal('fetch', vi.fn((url: string) => {
  if (url.startsWith('/api/player/resolve')) {
    const id = new URL(url, 'http://localhost').searchParams.get('id') ?? '';
    resolves.push(id);
    return Promise.resolve(new Response(JSON.stringify({
      available: true,
      streamUrl: `/api/player/stream?id=${id}`,
      track: { id, name: `Track ${id}`, artists: 'Someone', duration_ms: 210_000 },
    }), { headers: { 'content-type': 'application/json' } }));
  }
  return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
}));

const { player } = await import('./engine.ts');

const withSrc = (id: string) => created.find((el) => el.src.includes(`id=${id}`));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** Play `a`, prefetch `b` into the standby, and end `a` so the swap happens. */
async function swapInto(a: string, b: string) {
  player.setQueue([
    { id: a, name: 'One', artists: 'Someone', durationMs: 210_000 },
    { id: b, name: 'Two', artists: 'Someone', durationMs: 210_000 },
  ], a);
  await player.playAt(0);
  await vi.advanceTimersByTimeAsync(0);

  const first = withSrc(a)!;
  // Inside the prefetch window: the standby element takes the next track.
  first.currentTime = 200;
  first.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(0);
  const second = withSrc(b);
  expect(second, 'the next track should be prefetched into the standby').toBeTruthy();

  first.fire('ended');
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().currentId).toBe(b);
  return second!;
}

test('a stalled swap stays unmuted and retries on the previous element', async () => {
  const second = await swapInto('s1', 's2');
  expect(second.muted, 'a muted standby plays every swapped track in silence').toBe(false);
  expect(second.paused).toBe(false);

  // It never moves: play() is the kind of promise that never settles.
  const before = resolves.filter((id) => id === 's2').length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(resolves.filter((id) => id === 's2').length, 'the track should be resolved and loaded again')
    .toBe(before + 1);
  expect(withSrc('s2'), 'retry on the element that successfully played the previous track').not.toBe(second);
  expect(second.paused).toBe(true);
});

test('a swap that is playing is left alone', async () => {
  const second = await swapInto('s3', 's4');
  // Real progress on the element: the watchdog must not reload under it.
  second.currentTime = 3;
  const before = resolves.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(resolves.length).toBe(before);
});

test('a late rejected swap cannot replace a newer track', async () => {
  const second = await swapInto('late1', 'late2');
  // Simulate a second swap whose play promise rejects after a new selection.
  let reject!: (reason: Error) => void;
  const target = created.find(el => el !== second)!;
  target.playResult = new Promise<void>((_, fail) => { reject = fail; });
  player.append([{id: 'late3', name: 'Three', artists: 'Someone', durationMs: 210_000}]);
  second.currentTime = 200;
  second.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(0);
  await player.next();
  expect(player.getSnapshot().currentId).toBe('late3');
  expect(withSrc('late3')).toBe(target);
  target.playResult = null;
  player.setQueue([{id: 'chosen', name: 'Chosen', artists: 'Someone', durationMs: 210_000}], 'chosen', false);
  await player.playAt(0);
  reject(new Error('old play aborted'));
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().currentId).toBe('chosen');
  expect(withSrc('chosen')).toBe(target);
  expect(target.paused).toBe(false);
  player.toggle();
  expect(target.paused, 'Pause must still control the newly selected track').toBe(true);
});

test('a stalled swap after queue history is trimmed still retries the current track', async () => {
  const tracks = Array.from({length: 14}, (_, i) => ({id: `trim${i}`, name: `Track ${i}`, artists: 'Someone', durationMs: 210_000}));
  player.setQueue(tracks, 'trim10', false);
  await player.playAt(10);
  const first = withSrc('trim10')!;
  first.currentTime = 200;
  first.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(0);
  first.fire('ended');
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().queueIndex).toBe(10);
  await vi.advanceTimersByTimeAsync(5000);
  expect(withSrc('trim11')).toBe(first);
  expect(player.getSnapshot().currentId).toBe('trim11');
});

test('pausing a pending swap cancels its retry', async () => {
  const second = await swapInto('pause1', 'pause2');
  const before = resolves.length;
  player.toggle();
  await vi.advanceTimersByTimeAsync(5000);
  expect(second.paused).toBe(true);
  expect(resolves.length).toBe(before);
});

test('media-key pause cancels a pending swap retry', async () => {
  const second = await swapInto('media1', 'media2');
  const before = resolves.length;
  mediaHandlers.get('pause')!({ action: 'pause' });
  await vi.advanceTimersByTimeAsync(5000);
  expect(resolves.length).toBe(before);
  expect(second.paused).toBe(true);
});
