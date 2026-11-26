// The bug this pins: a song that "ended" two-thirds of the way through.
//
// On 2026-11-25 the reverse proxy at home restarted for twelve seconds while
// the Mac app was playing a six-minute FLAC. The next range request failed,
// and WebKit does not report that as an error: AVFoundation plays to the last
// byte it has, WebKit rewrites the element's duration to that point, and
// `ended` fires. The player took it at its word and skipped to the next song
// at 3:22. These tests replay that sequence: duration overwritten, then
// `ended`, with no `error` at any point.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

type Listener = (event: { target: unknown }) => void;

class FakeAudio {
  preload = '';
  src = '';
  currentTime = 0;
  duration = NaN;
  paused = true;
  volume = 1;
  playbackRate = 1;
  error: unknown = null;
  ended = false;
  private listeners = new Map<string, Listener[]>();
  load() { this.currentTime = 0; this.paused = true; this.duration = NaN; this.ended = false; }
  pause() { this.paused = true; }
  play(): Promise<void> {
    // As the spec has it: play() on an ended element starts from the top.
    if (this.ended) { this.currentTime = 0; this.ended = false; }
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

/** The scanned length of every track, as the server sends it on resolve. */
const SCANNED_MS = 373_453;
/** False while the server is unreachable: every request fails. */
let online = true;
/** What resolve says the song's scanned length is; null when it has none. */
let scannedMs: number | null = SCANNED_MS;

vi.stubGlobal('fetch', vi.fn((url: string) => {
  if (!online) return Promise.reject(new TypeError('Failed to fetch'));
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  }));
  if (url.startsWith('/api/player/resolve')) {
    const id = new URL(url, 'http://localhost').searchParams.get('id') ?? '';
    return json({
      available: true,
      streamUrl: `/api/player/stream?id=${id}`,
      track: { id, name: `Track ${id}`, artists: 'Someone', duration_ms: scannedMs },
    });
  }
  if (url.startsWith('/api/player/status')) return json({ state: 'ready' });
  return json({});
}));

const { player } = await import('./engine.ts');

const item = (id: string) => ({ id, name: `Track ${id}`, artists: 'Someone', durationMs: SCANNED_MS });
const playing = () => created.find((el) => el.src.includes('/api/player/stream'))!;

/** Start `first` of a two-track queue and let it report its real length. */
async function start(first: string, second: string, ownLength = SCANNED_MS / 1000) {
  player.setQueue([item(first), item(second)], first);
  await player.playAt(0);
  await vi.advanceTimersByTimeAsync(0);
  const el = playing();
  el.duration = ownLength;
  el.fire('durationchange');
  el.currentTime = 100;
  el.fire('play');
  el.fire('timeupdate');
  return el;
}

/** What WebKit does when a range request fails: cut the length, then end. */
function streamStopsAt(el: FakeAudio, seconds: number) {
  el.currentTime = seconds;
  el.duration = seconds;
  el.fire('durationchange');
  el.paused = true;
  el.ended = true;
  el.fire('pause');
  el.fire('ended');
}

beforeEach(() => {
  online = true;
  scannedMs = SCANNED_MS;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-25T08:57:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

test('a stream cut off mid-song picks up where it stopped instead of skipping', async () => {
  const el = await start('spiral', 'after');
  const url = el.src;

  streamStopsAt(el, 202.29);
  await vi.advanceTimersByTimeAsync(0);

  expect(player.getSnapshot().currentId, 'the song must not be skipped').toBe('spiral');
  expect(player.getSnapshot().overline).toBe('Reconnecting');

  await vi.advanceTimersByTimeAsync(1000);
  el.duration = SCANNED_MS / 1000;
  el.fire('loadedmetadata');

  expect(el.src, 'the same stream is asked for again').toBe(url);
  expect(el.currentTime, 'from where it stopped').toBeCloseTo(202.29, 2);
  expect(el.paused).toBe(false);
  expect(created.some((other) => other.src.includes('id=after'))).toBe(false);
});

test('a song that plays to its end still moves on', async () => {
  const el = await start('whole', 'next-one');

  streamStopsAt(el, SCANNED_MS / 1000 - 0.05);
  await vi.advanceTimersByTimeAsync(0);

  expect(player.getSnapshot().currentId).toBe('next-one');
});

test('a file shorter than the library says is not mistaken for a broken stream', async () => {
  // The scan fell back to Spotify's length for another edition, but the file
  // itself says 5:00 and played all of it.
  const el = await start('edition', 'then', 300);

  streamStopsAt(el, 300);
  await vi.advanceTimersByTimeAsync(0);

  expect(player.getSnapshot().currentId).toBe('then');
});

test('while the server is gone it waits for it, then carries on in the same song', async () => {
  const el = await start('outage', 'later');

  online = false;
  streamStopsAt(el, 202.29);
  // Each quick retry reloads the stream, which fails while the server is down.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await vi.advanceTimersByTimeAsync(1000 * attempt);
    el.fire('error');
  }
  await vi.advanceTimersByTimeAsync(0);

  expect(player.getSnapshot().overline).toBe('Waiting for the connection');
  expect(player.getSnapshot().currentId).toBe('outage');

  online = true;
  await vi.advanceTimersByTimeAsync(2000);
  await vi.advanceTimersByTimeAsync(0);
  el.fire('play');

  expect(player.getSnapshot().currentId, 'still the same song').toBe('outage');
  expect(el.src).toContain('id=outage');
  expect(el.currentTime, 'from where it stopped').toBeCloseTo(202.29, 2);
});

test('a stream that keeps stopping at the same place moves on once the retries are spent', async () => {
  const el = await start('truncated', 'onwards');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    streamStopsAt(el, 202.29);
    await vi.advanceTimersByTimeAsync(1000 * attempt);
    el.duration = SCANNED_MS / 1000;
    el.fire('loadedmetadata');
  }
  streamStopsAt(el, 202.29);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);

  expect(player.getSnapshot().currentId).toBe('onwards');
});

test('a seek made while it checks for the server is where it carries on from', async () => {
  const el = await start('moved', 'past');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    streamStopsAt(el, 202.29);
    await vi.advanceTimersByTimeAsync(1000 * attempt);
    el.duration = SCANNED_MS / 1000;
    el.fire('loadedmetadata');
  }
  // Out of quick retries, the server gone. The listener drags the bar while
  // the player is still asking whether the server answers.
  online = false;
  streamStopsAt(el, 202.29);
  player.seekTo(240);
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().overline).toBe('Waiting for the connection');

  online = true;
  await vi.advanceTimersByTimeAsync(2000);
  await vi.advanceTimersByTimeAsync(0);

  expect(player.getSnapshot().currentId).toBe('moved');
  expect(el.currentTime, 'where the listener dragged it, not where it broke').toBe(240);
});

test('Play after the wait for the server gives up picks up where it stopped', async () => {
  const el = await start('long-outage', 'meanwhile');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    streamStopsAt(el, 202.29);
    await vi.advanceTimersByTimeAsync(1000 * attempt);
    el.duration = SCANNED_MS / 1000;
    el.fire('loadedmetadata');
  }
  online = false;
  streamStopsAt(el, 202.29);
  // Longer than the player waits for the server.
  await vi.advanceTimersByTimeAsync(16 * 60_000);
  expect(player.getSnapshot().state).toBe('error');

  online = true;
  player.toggle();
  await vi.advanceTimersByTimeAsync(0);

  expect(player.getSnapshot().currentId).toBe('long-outage');
  expect(el.currentTime, 'not from the top').toBeCloseTo(202.29, 2);
});

test('a seek made while it waits to retry is where the retry goes', async () => {
  const el = await start('impatient', 'later-still');

  streamStopsAt(el, 202.29);
  player.seekTo(240);
  await vi.advanceTimersByTimeAsync(1000);
  el.duration = SCANNED_MS / 1000;
  el.fire('loadedmetadata');

  expect(player.getSnapshot().currentId).toBe('impatient');
  expect(el.currentTime, 'where the listener dragged it, not where it broke').toBe(240);
});

test('Pause while it waits to retry, then Play, picks up where it stopped', async () => {
  const el = await start('paused-mid-retry', 'not-yet');
  const pause = () => (player as unknown as { pause(): void }).pause();

  streamStopsAt(el, 202.29);
  await vi.advanceTimersByTimeAsync(0);
  // The media key, before the first retry runs.
  pause();
  await vi.advanceTimersByTimeAsync(5000);
  expect(player.getSnapshot().state).toBe('paused');
  expect(player.getSnapshot().overline).toBe('Paused');

  player.toggle();
  await vi.advanceTimersByTimeAsync(0);

  expect(player.getSnapshot().currentId).toBe('paused-mid-retry');
  expect(el.currentTime, 'not from the top').toBeCloseTo(202.29, 2);
  expect(el.paused).toBe(false);
});

test('Pause while a retry reloads the stream, then Play, picks up where it stopped', async () => {
  const el = await start('paused-mid-reload', 'not-this-one');
  const pause = () => (player as unknown as { pause(): void }).pause();

  streamStopsAt(el, 202.29);
  // The retry has reloaded the stream but it has not answered yet.
  await vi.advanceTimersByTimeAsync(1000);
  pause();
  el.duration = SCANNED_MS / 1000;
  el.fire('loadedmetadata');
  expect(el.currentTime, 'the cancelled retry does not seek').toBe(0);

  player.toggle();
  await vi.advanceTimersByTimeAsync(0);

  expect(player.getSnapshot().currentId).toBe('paused-mid-reload');
  expect(el.currentTime, 'not from the top').toBeCloseTo(202.29, 2);
});

test('with only the file\'s own length to go by, a few seconds short is still the end', async () => {
  // No scanned length, and an estimated one from the file that is 5 s long.
  scannedMs = null;
  const el = await start('estimated', 'following', 245);

  streamStopsAt(el, 240);
  await vi.advanceTimersByTimeAsync(0);

  expect(player.getSnapshot().currentId).toBe('following');
});

test('Play at the end of the queue after a song that kept stopping starts it over', async () => {
  player.setQueue([item('cut-last')], 'cut-last');
  await player.playAt(0);
  await vi.advanceTimersByTimeAsync(0);
  const el = playing();
  el.duration = SCANNED_MS / 1000;
  el.fire('durationchange');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    streamStopsAt(el, 202.29);
    await vi.advanceTimersByTimeAsync(1000 * attempt);
    el.duration = SCANNED_MS / 1000;
    el.fire('loadedmetadata');
  }
  streamStopsAt(el, 202.29);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(player.getSnapshot().overline).toBe('End of queue');

  player.toggle();
  await vi.advanceTimersByTimeAsync(0);

  expect(el.currentTime, 'from the top, as any end of the queue').toBe(0);
  expect(el.paused).toBe(false);
});

test('Pause just after a reconnect lands a hair early, then Play, just carries on', async () => {
  const el = await start('landed', 'after-that');
  const pause = () => (player as unknown as { pause(): void }).pause();
  const resolves = () => vi.mocked(fetch).mock.calls
    .filter(([url]) => String(url).startsWith('/api/player/resolve')).length;

  streamStopsAt(el, 202.29);
  await vi.advanceTimersByTimeAsync(1000);
  el.duration = SCANNED_MS / 1000;
  el.fire('loadedmetadata');
  // The decoder snaps the seek to a frame just before where it was asked.
  el.currentTime = 202.27;
  el.fire('play');
  const before = resolves();

  pause();
  el.fire('pause');
  player.toggle();
  await vi.advanceTimersByTimeAsync(0);

  expect(resolves(), 'no reload').toBe(before);
  expect(el.currentTime).toBeCloseTo(202.27, 2);
  expect(el.paused).toBe(false);
});

test('Previous while it waits to retry starts the song over', async () => {
  const el = await start('again', 'not-next');

  streamStopsAt(el, 202.29);
  player.previous();
  await vi.advanceTimersByTimeAsync(1000);
  el.duration = SCANNED_MS / 1000;
  el.fire('loadedmetadata');

  expect(player.getSnapshot().currentId).toBe('again');
  expect(el.currentTime, 'from the top, not back to where it broke').toBe(0);
  expect(el.paused).toBe(false);
});
