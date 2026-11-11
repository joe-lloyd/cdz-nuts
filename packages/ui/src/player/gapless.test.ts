// The bug this pins: a pause of about a second between songs.
//
// The next track was only buffered while fewer than thirty tracks were queued
// ahead, so any long album, playlist or station loaded every next track cold
// at the boundary. Even when it was buffered, the swap waited for `ended`,
// which lands a beat after the last sample. A boundary should be seamless.

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
  error: unknown = null;
  private listeners = new Map<string, Listener[]>();
  load() { this.currentTime = 0; this.paused = true; }
  pause() { this.paused = true; }
  play(): Promise<void> {
    this.paused = false;
    if (this.src.startsWith('data:')) return new Promise(() => {});
    return Promise.resolve();
  }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  fire(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ target: this });
  }
}

const created: FakeAudio[] = [];
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
/** A queue as long as a big album or playlist: more than thirty ahead. */
const longQueue = (prefix: string) => Array.from({ length: 40 }, (_, i) => ({
  id: `${prefix}${i}`, name: `Track ${i}`, artists: 'Someone', durationMs: 210_000,
}));

beforeEach(() => { vi.useFakeTimers(); resolves.length = 0; });
afterEach(() => { vi.useRealTimers(); });

async function playFirstOf(prefix: string) {
  player.setQueue(longQueue(prefix), `${prefix}0`);
  await player.playAt(0);
  await vi.advanceTimersByTimeAsync(0);
  return withSrc(`${prefix}0`)!;
}

test('the next track is buffered even with a long queue ahead', async () => {
  const first = await playFirstOf('a');
  first.currentTime = 195;
  first.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(0);
  expect(resolves, 'the next track must be resolved ahead of the boundary').toContain('a1');
  expect(withSrc('a1'), 'and loaded into the standby element').toBeTruthy();
});

test('the next track starts as this one runs out, without waiting for ended', async () => {
  const first = await playFirstOf('b');
  first.currentTime = 195;
  first.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(0);
  const second = withSrc('b1')!;

  // Half a second left. No `ended` will be fired in this test.
  first.currentTime = 209.5;
  first.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(400);
  expect(player.getSnapshot().currentId, 'too early: there is still music left').toBe('b0');
  await vi.advanceTimersByTimeAsync(100);
  expect(player.getSnapshot().currentId).toBe('b1');
  expect(second.paused).toBe(false);
  // The outgoing track plays out its last moments under the incoming one's
  // start-up, instead of being cut.
  expect(first.paused, 'the tail must not be cut').toBe(false);
  expect(first.src).toContain('id=b0');

  first.fire('ended');
  expect(first.paused).toBe(true);
  expect(first.src, 'retired once its audio has run out').toBe('');
});

test('an outgoing element that never reports ended is still retired', async () => {
  const first = await playFirstOf('e');
  first.currentTime = 195;
  first.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(0);
  first.currentTime = 209.5;
  first.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(500);
  expect(player.getSnapshot().currentId).toBe('e1');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(first.paused).toBe(true);
  expect(first.src).toBe('');
});

test('an estimated duration is not trusted to time the handoff', async () => {
  const first = await playFirstOf('f');
  // An Ogg element guessing 200s for a track the scan knows is 210s.
  first.duration = 200;
  first.currentTime = 195;
  first.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(0);
  first.currentTime = 199.5;
  first.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(2_000);
  expect(player.getSnapshot().currentId, 'ten seconds of the song would be lost').toBe('f0');

  // The real end still advances.
  first.fire('ended');
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().currentId).toBe('f1');
});

test('a seek just before the handoff fires cancels it at once', async () => {
  const first = await playFirstOf('g');
  first.currentTime = 195;
  first.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(0);
  first.currentTime = 209.5;
  first.fire('timeupdate');

  // No timeupdate follows the seek before the timer would have fired.
  player.seekTo(60);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(player.getSnapshot().currentId).toBe('g0');
});

test('seeking back from the end cancels the handoff', async () => {
  const first = await playFirstOf('c');
  first.currentTime = 195;
  first.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(0);
  first.currentTime = 209.5;
  first.fire('timeupdate');

  first.currentTime = 100;
  first.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(2_000);
  expect(player.getSnapshot().currentId).toBe('c0');
});

test('a pause near the end does not advance', async () => {
  const first = await playFirstOf('d');
  first.currentTime = 195;
  first.fire('timeupdate');
  await vi.advanceTimersByTimeAsync(0);
  first.currentTime = 209.5;
  first.fire('timeupdate');

  player.toggle(); // pause
  await vi.advanceTimersByTimeAsync(2_000);
  expect(player.getSnapshot().currentId).toBe('d0');
});
