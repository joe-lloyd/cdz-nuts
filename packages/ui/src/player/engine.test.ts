// Regression tests for the two ways `next()` could stop working entirely.
//
// The engine is a singleton created at import, owning two real audio
// elements, so both have to be stubbed before it is loaded -- hence the
// dynamic import at the bottom of the setup rather than a static one.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/** Just enough HTMLAudioElement for the engine to drive. */
class FakeAudio {
  preload = '';
  src = '';
  currentTime = 0;
  duration = NaN;
  paused = true;
  volume = 1;
  playbackRate = 1;
  /** Resolves only when the test says so, standing in for a starved element. */
  playResult: Promise<void> = Promise.resolve();
  load() {}
  pause() { this.paused = true; }
  play(): Promise<void> { this.paused = false; return this.playResult; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  addEventListener() {}
  removeEventListener() {}
}

const item = (n: number) => ({
  id: `t${n}`, name: `Track ${n}`, artists: 'Someone', durationMs: 210_000,
});

/** Resolve calls the test can inspect, and a switch to make them hang. */
let resolveCalls: string[];
let hang: boolean;

vi.stubGlobal('Audio', FakeAudio);
vi.stubGlobal('fetch', vi.fn((url: string) => {
  if (url.startsWith('/api/player/resolve')) {
    const id = new URL(url, 'http://localhost').searchParams.get('id') ?? '';
    resolveCalls.push(id);
    // A request that never settles: the engine awaits this, and nothing
    // downstream of it will ever run.
    if (hang) return new Promise<Response>(() => {});
    return Promise.resolve(new Response(JSON.stringify({
      available: true,
      streamUrl: `/api/player/stream?id=${id}`,
      track: { id, name: `Track ${id}`, artists: 'Someone', duration_ms: 210_000 },
    }), { headers: { 'content-type': 'application/json' } }));
  }
  return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
}));

const { player } = await import('./engine.ts');

beforeEach(() => {
  resolveCalls = [];
  hang = false;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

test('an advance that never completes does not disable every later advance', async () => {
  // The bug this pins: `advancing` was a boolean cleared in a `finally`, so an
  // await that never settled left it true forever. A play() promise on a
  // starved media element does exactly that. One stalled track then killed
  // auto-advance, the Next button and the media keys for the life of the
  // document -- invisible in a browser tab, fatal in a tray app left running
  // for days.
  player.setQueue([item(1), item(2), item(3)], 't1');

  hang = true;
  void player.next();
  await Promise.resolve();
  expect(resolveCalls, 'the wedged advance should have started').toEqual(['t2']);

  // Still inside the guard window: a second advance is correctly refused.
  void player.next();
  await Promise.resolve();
  expect(resolveCalls, 'overlapping advances must still coalesce').toEqual(['t2']);

  // Past it, the guard must have let go of its own accord.
  vi.setSystemTime(new Date('2026-01-01T00:00:20Z'));
  hang = false;
  void player.next();
  await Promise.resolve();
  expect(resolveCalls.length, 'next() was still wedged by the stalled advance')
    .toBeGreaterThan(1);
});

test('both audio elements pre-buffer, so every other track is not left empty', async () => {
  // `next()` alternates which element is active, so the two swap between
  // "playing" and "standby" on every track. If only one of them preloads
  // eagerly, prefetchNext marks the other ready having fetched nothing but
  // metadata, and half the gapless swaps land on an element with no audio.
  const elements = (player as unknown as { audioA: FakeAudio; audioB: FakeAudio });
  expect(elements.audioA.preload).toBe('auto');
  expect(elements.audioB.preload).toBe(elements.audioA.preload);
});
