import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// The module holds throttle state across calls, so each test gets a fresh copy
// rather than inheriting whatever the previous one left behind.
type Bridge = typeof import('./nativeBridge.ts');
let bridge: Bridge;
let posted: string[];

const nowPlaying = (over: Partial<Parameters<Bridge['sendNowPlaying']>[0]> = {}) => ({
  title: 'The 78', artist: 'Steven Wilson', album: 'Insurgentes',
  artworkUrl: 'https://music.home.arpa/img/local/x.jpg',
  playing: true, positionSec: 12, durationSec: 287,
  canNext: true, canPrevious: true, ...over,
});

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  posted = [];
  (window as unknown as Record<string, unknown>).ReactNativeWebView = {
    postMessage: (data: string) => { posted.push(data); },
  };
  bridge = await import('./nativeBridge.ts');
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).ReactNativeWebView;
});

test('a plain browser is not a native host, and nothing is sent', async () => {
  delete (window as unknown as Record<string, unknown>).ReactNativeWebView;
  vi.resetModules();
  const plain = await import('./nativeBridge.ts');
  expect(plain.hasNativeHost()).toBe(false);
  plain.sendNowPlaying(nowPlaying());
  plain.sendGone();
  expect(posted).toEqual([]);
});

test('the host is told what is playing, tagged so it can tell us apart', () => {
  bridge.sendNowPlaying(nowPlaying());
  expect(posted).toHaveLength(1);
  const message = JSON.parse(posted[0]!);
  // The Jellyfin bridge shares this channel; the source is how they are split.
  expect(message.source).toBe('homearpa-music');
  expect(message.kind).toBe('nowplaying');
  expect(message.title).toBe('The 78');
  expect(message.artist).toBe('Steven Wilson');
  expect(message.durationSec).toBe(287);
});

test('position ticks are throttled, so the bridge is not a hot path', () => {
  bridge.sendNowPlaying(nowPlaying({ positionSec: 12 }));
  bridge.sendNowPlaying(nowPlaying({ positionSec: 12.3 }));
  bridge.sendNowPlaying(nowPlaying({ positionSec: 12.6 }));
  expect(posted).toHaveLength(1);

  vi.advanceTimersByTime(1000);
  bridge.sendNowPlaying(nowPlaying({ positionSec: 13 }));
  expect(posted).toHaveLength(2);
});

test('pausing is never throttled', () => {
  // The case the throttle must not catch: a lock-screen card that lags the
  // pause button by a second reads as a broken app.
  bridge.sendNowPlaying(nowPlaying({ playing: true }));
  bridge.sendNowPlaying(nowPlaying({ playing: false }));
  expect(posted).toHaveLength(2);
  expect(JSON.parse(posted[1]!).playing).toBe(false);
});

test('a new track is never throttled either', () => {
  bridge.sendNowPlaying(nowPlaying({ title: 'Harmony Korine' }));
  bridge.sendNowPlaying(nowPlaying({ title: 'Abandoner' }));
  expect(posted.map((p) => JSON.parse(p).title)).toEqual(['Harmony Korine', 'Abandoner']);
});

test('stopping tells the host to drop its notification', () => {
  bridge.sendNowPlaying(nowPlaying());
  bridge.sendGone();
  expect(JSON.parse(posted[1]!)).toEqual({ source: 'homearpa-music', kind: 'gone' });
});

test('after gone, the same track sends again rather than being throttled away', () => {
  // Otherwise stopping and restarting the same song inside a second would
  // leave the host with no notification and no message to rebuild one from.
  bridge.sendNowPlaying(nowPlaying());
  bridge.sendGone();
  bridge.sendNowPlaying(nowPlaying());
  expect(posted).toHaveLength(3);
});

test('a host command runs the matching handler, named as MediaSession names it', () => {
  const calls: string[] = [];
  bridge.installNativeCommands({
    play: () => calls.push('play'),
    nexttrack: () => calls.push('nexttrack'),
    seekto: (d) => calls.push(`seekto:${d.seekTime}`),
  });
  const host = (window as unknown as { __homearpaMusic: { command(a: string, d?: unknown): void } })
    .__homearpaMusic;
  host.command('play');
  host.command('nexttrack');
  host.command('seekto', { seekTime: 42 });
  expect(calls).toEqual(['play', 'nexttrack', 'seekto:42']);
});

test('the handler is given the action name the browser would have given it', () => {
  let seen: MediaSessionActionDetails | null = null;
  bridge.installNativeCommands({ pause: (d) => { seen = d; } });
  (window as unknown as { __homearpaMusic: { command(a: string): void } })
    .__homearpaMusic.command('pause');
  expect(seen!.action).toBe('pause');
});

test('an unknown or failing command cannot take the player down', () => {
  bridge.installNativeCommands({ play: () => { throw new Error('boom'); } });
  const host = (window as unknown as { __homearpaMusic: { command(a: string): void } })
    .__homearpaMusic;
  expect(() => host.command('nosuchaction')).not.toThrow();
  expect(() => host.command('play')).not.toThrow();
});

test('artwork is made absolute, because the host has no document to resolve against', () => {
  expect(bridge.absoluteUrl('/img/local/x.jpg')).toBe(`${location.origin}/img/local/x.jpg`);
  expect(bridge.absoluteUrl('https://elsewhere/x.jpg')).toBe('https://elsewhere/x.jpg');
  expect(bridge.absoluteUrl('')).toBe('');
});
