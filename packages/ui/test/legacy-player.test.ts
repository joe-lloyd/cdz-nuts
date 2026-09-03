// Characterisation tests: what the shipped player does today.
//
// These are written against legacy/player.js so that the React engine can be
// held to the same behaviour. Where a rule looks odd, it is pinned anyway --
// the point is to notice if it changes, not to decide whether it should.

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { mountLegacyPlayer, type Harness, type Track } from './legacy-player.ts';

const track = (n: number, over: Partial<Track> = {}): Track => ({
  id: `t${n}`,
  name: `Track ${n}`,
  artists: `Artist ${n}`,
  durationMs: 210_000,
  albumId: `alb${n}`,
  ...over,
});

/** The shape /api/player/resolve answers with for a playable track. */
const resolved = (id: string) => ({
  ok: true,
  streamUrl: `/api/player/stream?id=${id}`,
  playable: true,
});

let player: Harness;

beforeEach(() => {
  vi.useRealTimers();
  player = mountLegacyPlayer((url) => {
    if (url.includes('/api/player/resolve')) {
      const id = new URL(url, 'http://localhost').searchParams.get('id') ?? '';
      return resolved(id);
    }
    if (url.includes('/api/player/status')) return { awake: true };
    if (url.includes('/api/player/lyrics')) return { lines: [] };
    return {};
  });
});

describe('the harness itself', () => {
  test('boots the real player against the real markup', () => {
    expect(player.audio).toBeTruthy();
    expect(player.bar).toBeTruthy();
    // The bar's data-state attribute is the entire visual state machine, and
    // the CSS keys off it. It must start idle.
    expect(player.bar.dataset.state).toBe('idle');
  });

  test('exposes the two globals the station view depends on', () => {
    // player.js puts these on window precisely because the station view lives
    // in the other script. If they disappear, radio silently stops queueing.
    expect(typeof (window as unknown as { musicQueueAppend: unknown }).musicQueueAppend)
      .toBe('function');
    expect(typeof (window as unknown as { musicQueueHas: unknown }).musicQueueHas)
      .toBe('function');
  });

  test('creates a second audio element for pre-buffering', () => {
    // Two elements, one of them detached: this is how gapless works, and it is
    // the constraint that stops the engine living inside a React component.
    expect(player.allAudio().length).toBeGreaterThanOrEqual(2);
  });
});

describe('building the queue from the DOM', () => {
  test('a click queues the whole row, starting at the one clicked', async () => {
    player.playFromRows([track(1), track(2), track(3)], 1);
    await vi.waitFor(() => expect(player.has('t2')).toBe(true));

    // All three are queued -- clicking one track queues its context, it does
    // not play a single song in isolation.
    expect(player.has('t1')).toBe(true);
    expect(player.has('t3')).toBe(true);
    // ...and the one clicked is what gets resolved first.
    expect(player.calls.some((c) => c.includes('/api/player/resolve?id=t2'))).toBe(true);
  });

  test('a track not in the queue is not claimed to be', () => {
    expect(player.has('never-queued')).toBe(false);
  });
});

describe('previous', () => {
  test('past four seconds it restarts the track instead of going back', async () => {
    player.playFromRows([track(1), track(2)], 1);
    await vi.waitFor(() => expect(player.has('t2')).toBe(true));

    player.seekTo(10);
    player.click('#previous-button');

    // The rule exists because pressing previous mid-song almost always means
    // "start this again", not "leave".
    expect(player.audio.currentTime).toBe(0);
  });

  test('within four seconds it steps back a track', async () => {
    player.playFromRows([track(1), track(2)], 1);
    await vi.waitFor(() =>
      expect(player.calls.some((c) => c.includes('resolve?id=t2'))).toBe(true));

    player.seekTo(2);
    player.click('#previous-button');

    await vi.waitFor(() =>
      expect(player.calls.some((c) => c.includes('resolve?id=t1'))).toBe(true));
  });

  test('at the first track it does nothing rather than wrapping', async () => {
    player.playFromRows([track(1), track(2)], 0);
    await vi.waitFor(() => expect(player.has('t1')).toBe(true));

    player.seekTo(1);
    const before = player.calls.length;
    player.click('#previous-button');

    // No wrap to the end of the queue, and no error.
    expect(player.calls.length).toBe(before);
  });
});

describe('what survives a reload', () => {
  test('the queue and position are persisted', async () => {
    player.playFromRows([track(1), track(2), track(3)], 0);
    await vi.waitFor(() => expect(player.storage()).toBeTruthy());

    const saved = player.storage() as { queue: Track[]; queueIndex: number };
    expect(saved.queue.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(saved.queueIndex).toBe(0);
  });

  test('the persisted track carries what the row supplied', async () => {
    player.playFromRows([track(1, { name: 'Real Name', artists: 'Real Artist' })], 0);
    await vi.waitFor(() => expect(player.storage()).toBeTruthy());

    const saved = player.storage() as { queue: Track[] };
    expect(saved.queue[0]).toMatchObject({
      id: 't1',
      name: 'Real Name',
      artists: 'Real Artist',
      durationMs: 210_000,
    });
  });
});

describe('appending from the station view', () => {
  test('tracks appended by the global join the existing queue', async () => {
    player.playFromRows([track(1)], 0);
    await vi.waitFor(() => expect(player.has('t1')).toBe(true));

    // Radio fetches land minutes after the station started; rebuilding the
    // queue from the page would restart playback, which is why this exists.
    player.append([track(9)]);
    expect(player.has('t9')).toBe(true);
    expect(player.has('t1')).toBe(true);
  });
});
