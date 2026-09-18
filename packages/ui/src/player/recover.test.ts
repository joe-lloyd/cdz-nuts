// The bug this pins: a single failed range request ended the song for good.
//
// On 2026-09-10 four /api/player/stream requests from a Mac got a 502 while
// the server container was being redeployed. Each one stopped playback dead
// with "Playback interrupted" and no way back except pressing play again. A
// deploy, a WiFi blip or eliot waking up should cost a listener a second, not
// the rest of the track.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

type Listener = (event: { target: unknown }) => void;

/** An audio element that records listeners, so a test can fail it mid-track. */
class FakeAudio {
  preload = '';
  src = '';
  currentTime = 0;
  duration = 210;
  paused = true;
  volume = 1;
  playbackRate = 1;
  loads = 0;
  plays = 0;
  private listeners = new Map<string, Listener[]>();

  load() { this.loads += 1; }
  pause() { this.paused = true; }
  play(): Promise<void> { this.paused = false; this.plays += 1; return Promise.resolve(); }
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
vi.stubGlobal('Audio', class extends FakeAudio {
  constructor() { super(); created.push(this); }
});
vi.stubGlobal('fetch', vi.fn((url: string) => {
  if (url.startsWith('/api/player/resolve')) {
    const id = new URL(url, 'http://localhost').searchParams.get('id') ?? '';
    return Promise.resolve(new Response(JSON.stringify({
      available: true,
      streamUrl: `/api/player/stream?id=${id}`,
      // The scanned length the server sends back. 'd1' is deliberately longer
      // than the element's guess, which is the case the scrubber test pins.
      track: { id, name: `Track ${id}`, artists: 'Someone', duration_ms: id === 'd1' ? 300_000 : 210_000 },
    }), { headers: { 'content-type': 'application/json' } }));
  }
  return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
}));

const { player } = await import('./engine.ts');

const active = () => created.find((el) => el.src) ?? created[0]!;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test('a stream that fails mid-track resumes where it stopped', async () => {
  player.setQueue([{ id: 't1', name: 'Track 1', artists: 'Someone', durationMs: 210_000 }], 't1');
  await player.playAt(0);
  await vi.advanceTimersByTimeAsync(0);

  const el = active();
  const url = el.src;
  expect(url, 'the track should be loaded before we break it').toBeTruthy();
  el.currentTime = 137;
  el.fire('error');

  // Not an error state: the listener should be trying again, not giving up.
  expect(player.getSnapshot().state).not.toBe('error');

  await vi.advanceTimersByTimeAsync(5000);
  el.fire('loadedmetadata');

  expect(el.src).toBe(url);
  expect(el.currentTime, 'it must pick the track up where it stopped').toBe(137);
  expect(el.paused).toBe(false);
});

test('a stream that keeps failing eventually gives up and says so', async () => {
  player.setQueue([{ id: 't2', name: 'Track 2', artists: 'Someone', durationMs: 210_000 }], 't2');
  await player.playAt(0);
  await vi.advanceTimersByTimeAsync(0);

  const el = active();
  el.currentTime = 12;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    el.fire('error');
    await vi.advanceTimersByTimeAsync(5000);
    el.fire('loadedmetadata');
  }

  expect(player.getSnapshot().state, 'retrying for ever is its own bug').toBe('error');
});

test('the queue advances on its own when a track ends', async () => {
  player.setQueue([
    { id: 'a1', name: 'Track A', artists: 'Someone', durationMs: 210_000 },
    { id: 'a2', name: 'Track B', artists: 'Someone', durationMs: 210_000 },
  ], 'a1');
  await player.playAt(0);
  await vi.advanceTimersByTimeAsync(0);

  const first = active();
  expect(first.src).toContain('a1');

  first.currentTime = 210;
  first.fire('ended');
  await vi.advanceTimersByTimeAsync(2000);

  const playing = created.find((el) => el.src.includes('a2'));
  expect(playing, 'the next track should be loaded and playing').toBeTruthy();
  expect(playing!.paused).toBe(false);
});

test('the standby element is made playable inside the first gesture', async () => {
  // WebKit refuses play() on an element that has never played inside a user
  // gesture, and the gapless swap plays the *other* element. Without this the
  // second track of every session is refused on macOS.
  const before = created.length;
  player.setQueue([{ id: 'b1', name: 'Track', artists: 'Someone', durationMs: 210_000 }], 'b1');
  await player.playAt(0);
  await vi.advanceTimersByTimeAsync(0);

  const both = created.slice(0, Math.max(before, 2));
  expect(both.every((el) => el.plays > 0), 'both elements must have played something').toBe(true);
});

test('the scrubber spans the real track, not the container is guess', async () => {
  // Ogg and Opus carry no duration in the header, so a browser estimates it
  // from the bitrate and only corrects itself if the tail is ever fetched --
  // which the desktop proxy's range cap can prevent. Dragging to the end then
  // landed short, and the remaining time hit zero while the song played on.
  // The scan knows the real length, so that is what the bar is drawn against.
  player.setQueue([{ id: 'd1', name: 'Long one', artists: 'Someone', durationMs: 300_000 }], 'd1');
  await player.playAt(0);
  await vi.advanceTimersByTimeAsync(0);

  const el = active();
  el.duration = 210;            // the element's guess, well short of the truth
  el.currentTime = 0;

  player.seekFraction(1);
  expect(el.currentTime, 'the end of the bar must be the end of the track').toBe(300);

  el.currentTime = 150;
  await vi.advanceTimersByTimeAsync(0);
  el.fire('timeupdate');
  const snap = player.getSnapshot();
  expect(snap.progress).toBeCloseTo(0.5, 2);
  expect(snap.remainingText).toBe('−2:30');
});
