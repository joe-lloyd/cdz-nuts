// The bug this pins: losing the connection at a track boundary stopped the
// music for good.
//
// Leaving the house moves the phone from home Wi-Fi to mobile data and the VPN
// back home. A track that ended during that handover could not resolve the
// next one; the bar went to an error and stayed there until someone pressed
// play, long after the VPN had the server back.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

type Listener = (event: { target: unknown }) => void;

class FakeAudio {
  preload = '';
  src = '';
  currentTime = 0;
  duration = 210;
  paused = true;
  volume = 1;
  playbackRate = 1;
  error: unknown = null;
  private listeners = new Map<string, Listener[]>();
  // As in a browser: loading resets the position and pauses the element.
  load() { this.currentTime = 0; this.paused = true; }
  pause() { this.paused = true; }
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
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

/** False while the phone is between networks: every request fails. */
let online: boolean;
let probes: number;

vi.stubGlobal('fetch', vi.fn((url: string) => {
  if (!online) return Promise.reject(new TypeError('Failed to fetch'));
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  }));
  if (url.startsWith('/api/player/status')) { probes += 1; return json({ state: 'ready' }); }
  if (url.startsWith('/api/player/resolve')) {
    const id = new URL(url, 'http://localhost').searchParams.get('id') ?? '';
    return json({
      available: true,
      streamUrl: `/api/player/stream?id=${id}`,
      track: { id, name: `Track ${id}`, artists: 'Someone', duration_ms: 210_000 },
    });
  }
  return json({});
}));

const { player } = await import('./engine.ts');

const item = (id: string) => ({ id, name: `Track ${id}`, artists: 'Someone', durationMs: 210_000 });
const active = () => created.find((el) => el.src && !el.src.startsWith('data:'))!;

beforeEach(() => {
  online = true;
  probes = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

test('the next track starts by itself once the connection is back', async () => {
  player.setQueue([item('a'), item('b')], 'a');
  await player.playAt(0);
  expect(player.getSnapshot().currentId).toBe('a');

  // The track runs out while the phone is between networks.
  online = false;
  vi.setSystemTime(Date.now() + 20_000);
  active().fire('ended');
  await vi.advanceTimersByTimeAsync(0);
  const waiting = player.getSnapshot();
  expect(waiting.state, 'a lost connection is not a dead end').toBe('loading');
  expect(waiting.overline).toBe('Waiting for the connection');

  // Still down after the first few checks: keep waiting.
  await vi.advanceTimersByTimeAsync(15_000);
  expect(player.getSnapshot().state).toBe('loading');

  // The VPN comes up. Nobody touches anything.
  online = true;
  await vi.advanceTimersByTimeAsync(30_000);
  const after = player.getSnapshot();
  expect(after.currentId).toBe('b');
  expect(after.state).not.toBe('error');
  expect(active().src).toContain('id=b');
});

test('coming back online checks at once rather than at the next step', async () => {
  player.setQueue([item('c')], 'c');
  online = false;
  await player.playAt(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().overline).toBe('Waiting for the connection');

  online = true;
  dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().currentId).toBe('c');
});

test('a stream that dies mid-track picks up where it stopped', async () => {
  player.setQueue([item('d')], 'd');
  await player.playAt(0);
  const el = active();
  el.currentTime = 95;

  online = false;
  // The quick retries all fail too; the server is simply not there.
  for (let failure = 0; failure < 4; failure += 1) el.fire('error');
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().overline).toBe('Waiting for the connection');

  online = true;
  await vi.advanceTimersByTimeAsync(30_000);
  el.fire('loadedmetadata');
  expect(player.getSnapshot().currentId).toBe('d');
  expect(el.currentTime).toBe(95);
  expect(el.paused).toBe(false);
});

test('pausing ends the wait', async () => {
  player.setQueue([item('e')], 'e');
  online = false;
  await player.playAt(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().overline).toBe('Waiting for the connection');

  player.toggle(); // play: checks now, still down
  await vi.advanceTimersByTimeAsync(0);
  (player as unknown as { pause(): void }).pause();
  // The element was already paused, so nothing else would redraw the bar.
  expect(player.getSnapshot().state).toBe('paused');
  expect(player.getSnapshot().overline).not.toBe('Waiting for the connection');
  online = true;
  probes = 0;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(probes, 'a paused player must not keep probing').toBe(0);
  expect(player.getSnapshot().currentId).not.toBe('e');
});

test('a retry that fails after reloading does not lose the place in the track', async () => {
  player.setQueue([item('f')], 'f');
  await player.playAt(0);
  const el = active();
  el.currentTime = 120;
  online = false;

  // Each quick retry reloads the element, which puts it back to zero, and
  // fails before its seek can land.
  el.fire('error');
  for (const backoff of [1_000, 2_000, 3_000]) {
    await vi.advanceTimersByTimeAsync(backoff);
    expect(el.currentTime).toBe(0);
    el.fire('error');
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().overline).toBe('Waiting for the connection');

  online = true;
  await vi.advanceTimersByTimeAsync(30_000);
  el.fire('loadedmetadata');
  expect(el.currentTime, 'the song must not restart').toBe(120);
});

test('play checks the connection even if the dead element still claims to play', async () => {
  player.setQueue([item('g')], 'g');
  await player.playAt(0);
  const el = active();
  el.currentTime = 30;
  online = false;
  for (let failure = 0; failure < 4; failure += 1) el.fire('error');
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().overline).toBe('Waiting for the connection');

  // A network error does not set paused. Play must still mean "check now".
  el.paused = false;
  online = true;
  probes = 0;
  player.toggle();
  await vi.advanceTimersByTimeAsync(0);
  expect(probes).toBeGreaterThan(0);
  expect(player.getSnapshot().overline).not.toBe('Waiting for the connection');
  expect(player.getSnapshot().currentId).toBe('g');
});

test('a new track does not inherit the last one\'s place', async () => {
  player.setQueue([item('h1'), item('h2')], 'h1');
  await player.playAt(0);
  active().currentTime = 120;
  active().fire('error'); // one quick retry under way for h1, at 120s

  await player.playAt(1);
  const el = active();
  el.currentTime = 10;
  online = false;
  for (let failure = 0; failure < 4; failure += 1) el.fire('error');
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().overline).toBe('Waiting for the connection');

  online = true;
  await vi.advanceTimersByTimeAsync(30_000);
  el.fire('loadedmetadata');
  expect(player.getSnapshot().currentId).toBe('h2');
  expect(el.currentTime, 'h2 must resume at its own place, not h1\'s').toBe(10);
});

test('choosing the current track again starts it fresh, not at the last break', async () => {
  player.setQueue([item('k')], 'k');
  await player.playAt(0);
  active().currentTime = 120;
  active().fire('error'); // a quick retry under way, at 120s

  await player.playAt(0); // picked again from the queue: a restart
  const el = active();
  el.currentTime = 5;
  online = false;
  for (let failure = 0; failure < 4; failure += 1) el.fire('error');
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().overline).toBe('Waiting for the connection');

  online = true;
  await vi.advanceTimersByTimeAsync(30_000);
  el.fire('loadedmetadata');
  expect(el.currentTime, 'the restart must not jump forward to the old break').toBe(5);
});

test('choosing a track paused during a wait starts it from the top', async () => {
  player.setQueue([item('m')], 'm');
  await player.playAt(0);
  const el = active();
  el.currentTime = 80;
  online = false;
  for (let failure = 0; failure < 4; failure += 1) el.fire('error');
  await vi.advanceTimersByTimeAsync(0);
  (player as unknown as { pause(): void }).pause();

  online = true;
  await player.playAt(0); // picked from the list, not Play on the bar
  expect(player.getSnapshot().currentId).toBe('m');
  expect(active().currentTime, 'a fresh pick must not resume the old place').toBe(0);
});

test('play after the last retry failed picks up where the track broke', async () => {
  player.setQueue([item('n')], 'n');
  await player.playAt(0);
  const el = active();
  el.currentTime = 120;
  // The server answers, but the stream keeps failing, and each quick retry
  // reloads the element to zero before it fails again.
  el.fire('error');
  for (const backoff of [1_000, 2_000, 3_000]) {
    await vi.advanceTimersByTimeAsync(backoff);
    el.fire('error');
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().state).toBe('error');
  expect(el.currentTime).toBe(0);

  el.error = { code: 2 };
  player.toggle();
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().currentId).toBe('n');
  expect(el.currentTime, 'Play must not restart the song').toBe(120);
});

for (const [how, seek, expected] of [
  ['seekTo', () => player.seekTo(30), 30],
  ['seekFraction', () => player.seekFraction(0), 0],
] as const) {
  test(`a seek back after failed retries wins over the old break (${how})`, async () => {
    player.setQueue([item(`s-${how}`)], `s-${how}`);
    await player.playAt(0);
    const el = active();
    el.duration = 210;
    el.currentTime = 120;
    el.fire('error');
    for (const backoff of [1_000, 2_000, 3_000]) {
      await vi.advanceTimersByTimeAsync(backoff);
      el.fire('error');
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(player.getSnapshot().state).toBe('error');

    seek();
    el.error = { code: 2 };
    player.toggle();
    await vi.advanceTimersByTimeAsync(0);
    expect(el.currentTime, 'Play must go where the listener seeked').toBe(expected);
  });
}

test('a seek during a connection wait is where it picks up', async () => {
  player.setQueue([item('sw')], 'sw');
  await player.playAt(0);
  const el = active();
  el.currentTime = 120;
  online = false;
  for (let failure = 0; failure < 4; failure += 1) el.fire('error');
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().overline).toBe('Waiting for the connection');

  player.seekTo(45);
  online = true;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(player.getSnapshot().currentId).toBe('sw');
  expect(el.currentTime).toBe(45);
});
