// The bug this pins: a track that was not in the library stayed unplayable
// after it arrived.
//
// Reaching a track the archive did not have queued it for download and showed
// "Not in the library — getting it now", then stopped looking. Play was
// disabled, so the only way to hear the track once it landed was to reload the
// page -- which in the tray app meant quitting and restarting it.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

class FakeAudio {
  preload = '';
  src = '';
  currentTime = 0;
  duration = 210;
  paused = true;
  volume = 1;
  playbackRate = 1;
  load() {}
  pause() { this.paused = true; }
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  addEventListener() {}
  removeEventListener() {}
}

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
}));

/** Track ids the archive has, and every resolve and want the engine sent. */
let inLibrary: Set<string>;
let resolveCalls: string[];
let wantCalls: number;

vi.stubGlobal('Audio', FakeAudio);
vi.stubGlobal('fetch', vi.fn((url: string) => {
  if (url.startsWith('/api/player/resolve')) {
    const id = new URL(url, 'http://localhost').searchParams.get('id') ?? '';
    resolveCalls.push(id);
    const track = { id, name: `Track ${id}`, artists: 'Someone', duration_ms: 210_000 };
    return inLibrary.has(id)
      ? json({ available: true, streamUrl: `/api/player/stream?id=${id}`, track })
      : json({ available: false, reason: 'not-matched', detail: 'No local file for this track', track });
  }
  if (url === '/api/tracks/want') {
    wantCalls += 1;
    return json({ detail: 'Fetching this track' });
  }
  return json({});
}));

const { player } = await import('./engine.ts');

const item = (id: string) => ({ id, name: `Track ${id}`, artists: 'Someone', durationMs: 210_000 });

/** Let the resolve's promise chain settle without moving the clock. */
const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

beforeEach(() => {
  inLibrary = new Set();
  resolveCalls = [];
  wantCalls = 0;
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

test('a missing track becomes playable once it lands, without starting by itself', async () => {
  player.setQueue([item('m1')], 'm1');
  await player.playAt(0);
  expect(player.getSnapshot().state).toBe('error');
  expect(wantCalls, 'reaching the track should ask for it').toBe(1);

  // Still being fetched: the next check finds nothing and keeps waiting.
  await vi.advanceTimersByTimeAsync(15_000);
  expect(player.getSnapshot().state).toBe('error');

  inLibrary.add('m1');
  await vi.advanceTimersByTimeAsync(15_000);
  const ready = player.getSnapshot();
  expect(ready.state, 'no longer stuck on "not in the library"').toBe('paused');
  expect(ready.canPlay).toBe(true);
  expect(ready.currentId, 'it must not start on its own').toBeNull();

  player.toggle();
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().currentId).toBe('m1');
  expect(wantCalls, 'the track is asked for once, not on every check').toBe(1);
});

test('play on a missing track checks for it again', async () => {
  player.setQueue([item('m2')], 'm2');
  await player.playAt(0);
  expect(player.getSnapshot().canPlay, 'play must not be a dead button').toBe(true);

  inLibrary.add('m2');
  const before = resolveCalls.length;
  player.toggle();
  await settle();
  expect(resolveCalls.length).toBe(before + 1);
  expect(player.getSnapshot().currentId).toBe('m2');
  expect(player.getSnapshot().state).not.toBe('error');
});

test('moving on stops the watch for a track nobody is waiting for', async () => {
  player.setQueue([item('m3'), item('ok')], 'm3');
  await player.playAt(0);
  inLibrary.add('ok');
  vi.setSystemTime(Date.now() + 20_000); // clear of the advance guard
  await player.next();
  expect(player.getSnapshot().currentId).toBe('ok');

  inLibrary.add('m3');
  resolveCalls = [];
  await vi.advanceTimersByTimeAsync(60_000);
  expect(resolveCalls, 'the abandoned track must not be polled or played').not.toContain('m3');
  expect(player.getSnapshot().currentId).toBe('ok');
});
