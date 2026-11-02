import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';

type Listener = (event: { target: FakeAudio }) => void;
class FakeAudio {
  static instances: FakeAudio[] = [];
  preload = ''; src = ''; currentTime = 0; duration = 210; paused = true; volume = 1;
  error: { code: number } | null = null;
  play = vi.fn(async () => { this.paused = false; });
  private listeners = new Map<string, Set<Listener>>();
  constructor() { FakeAudio.instances.push(this); }
  load() { this.currentTime = 0; this.error = null; }
  pause() { this.paused = true; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener) { this.listeners.get(type)?.delete(fn); }
  fire(type: string) { for (const fn of this.listeners.get(type) ?? []) fn({ target: this }); }
}
const host = window as Window & { __homearpaOutputVolumeEnabled?: boolean };
host.__homearpaOutputVolumeEnabled = true;
vi.stubGlobal('Audio', FakeAudio);
vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
  url === '/api/desktop/audio-output'
    ? { id: 'speakers', name: 'Speakers', builtInSpeakers: true }
    : { available: true, streamUrl: '/api/player/stream?id=test', track: { id: 'test', name: 'Track', duration_ms: 210_000 } },
))));
const { player } = await import('./engine.ts');
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
afterAll(() => { delete host.__homearpaOutputVolumeEnabled; vi.unstubAllGlobals(); });

test.each([0, 1000])('output changes cancel recovery after %i ms, including its metadata callback', async delay => {
  await vi.advanceTimersByTimeAsync(0);
  window.dispatchEvent(new CustomEvent('homearpa-audio-output', {
    detail: { id: 'speakers', name: 'Speakers', builtInSpeakers: true },
  }));
  player.setQueue([{ id: 'test', name: 'Track', artists: 'Artist', durationMs: 210_000 }], 'test', false);
  await player.playAt(0);
  await vi.advanceTimersByTimeAsync(0);
  const active = FakeAudio.instances[0]!;
  active.currentTime = 100;
  active.fire('timeupdate'); // Reset any previous recovery budget.
  active.currentTime = 20;
  active.fire('error');
  expect(player.getSnapshot().state).toBe('loading');
  await vi.advanceTimersByTimeAsync(delay);
  window.dispatchEvent(new CustomEvent('homearpa-audio-output', {
    detail: { id: 'headphones', name: 'Headphones', builtInSpeakers: false },
  }));
  const plays = active.play.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  active.fire('loadedmetadata');
  expect(active.play).toHaveBeenCalledTimes(plays);
  expect(active.paused).toBe(true);
  expect(player.getSnapshot().state).toBe('paused');
});

test('an output change also cancels auto-advance waiting for a continuation album', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.startsWith('/api/player/continuation')) return new Promise<Response>(resolve => { finish = resolve; });
    return Promise.resolve(new Response(JSON.stringify({
      available: true, streamUrl: '/api/player/stream?id=test', track: { id: 'test', name: 'Track', duration_ms: 210_000 },
    })));
  }));
  player.setQueue([{ id: 'test', name: 'Track', artists: 'Artist', durationMs: 210_000 }], 'test');
  await player.playAt(0);
  const active = FakeAudio.instances[0]!;
  const advancing = player.next();
  expect(player.getSnapshot().state).toBe('loading');
  window.dispatchEvent(new CustomEvent('homearpa-audio-output', {
    detail: { id: 'speakers', name: 'Speakers', builtInSpeakers: true },
  }));
  const plays = active.play.mock.calls.length;
  finish(new Response(JSON.stringify({ available: true, tracks: [{ id: 'next', name: 'Next' }] })));
  await advancing;
  expect(active.play).toHaveBeenCalledTimes(plays);
  expect(active.paused).toBe(true);
  expect(player.getSnapshot().state).toBe('paused');
});

test.each(['player', 'media control'])('late errors stay paused until an explicit %s Play request', async control => {
  player.setQueue([{ id: 'test', name: 'Track', artists: 'Artist', durationMs: 210_000 }], 'test', false);
  await player.playAt(0);
  const active = FakeAudio.instances[0]!;
  active.currentTime = 60;
  window.dispatchEvent(new CustomEvent('homearpa-audio-output', {
    detail: { id: `late-error-${control}`, name: 'Headphones', builtInSpeakers: false },
  }));
  const plays = active.play.mock.calls.length;
  active.error = { code: 2 };
  active.fire('error');
  active.fire('ended');
  await vi.advanceTimersByTimeAsync(5000);
  active.fire('loadedmetadata');
  expect(active.play).toHaveBeenCalledTimes(plays);
  expect(active.paused).toBe(true);
  expect(player.getSnapshot().state).toBe('paused');
  if (control === 'player') player.toggle();
  else (window as Window & { __homearpaMusic?: { command(action: string): void } }).__homearpaMusic!.command('play');
  await vi.advanceTimersByTimeAsync(0);
  expect(active.play).toHaveBeenCalledTimes(plays + 1);
  expect(active.paused).toBe(false);
  expect(active.error).toBeNull();
  expect(active.currentTime).toBe(60);
});
