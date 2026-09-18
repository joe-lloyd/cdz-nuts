import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { Track } from '../api/types.ts';

// The engine owns real audio elements, so the button's view of "what is
// playing" is stubbed rather than driven. What is under test here is the
// mapping from player state to markup -- which is exactly what broke.
const snapshot = { currentId: null as string | null, state: 'idle' as string };
vi.mock('../player/usePlayer.ts', () => ({
  usePlayer: () => snapshot,
  player: { notify: vi.fn() },
}));

const { PlayControl } = await import('./primitives.tsx');

const held = (over: Partial<Track> = {}): Track => ({
  id: 't1', name: 'Held Track', artists: 'An Artist',
  duration_ms: 200_000, quality: 'lossless', ...over,
});
const missing = (over: Partial<Track> = {}): Track => ({
  id: 't2', name: 'Missing Track', artists: 'An Artist', duration_ms: 200_000, ...over,
});

const draw = (track: Track) =>
  render(<MemoryRouter><PlayControl track={track} /></MemoryRouter>);

beforeEach(() => { snapshot.currentId = null; snapshot.state = 'idle'; });

describe('a track the library holds', () => {
  test('gets a play button', () => {
    draw(held());
    const button = screen.getByRole('button', { name: /play held track/i });
    expect(button).toHaveClass('track-play');
  });

  test('the button itself is marked while it plays, not just the row', () => {
    // The CSS hides the play glyph and animates equaliser bars through
    // `.track-play.playing`. Marking only the row leaves the button inert,
    // which is precisely the regression this pins.
    snapshot.currentId = 't1';
    snapshot.state = 'playing';
    draw(held());
    expect(screen.getByRole('button', { name: /play held track/i })).toHaveClass('track-play', 'playing');
  });

  test('and marked paused when it is the current track but stopped', () => {
    snapshot.currentId = 't1';
    snapshot.state = 'paused';
    draw(held());
    expect(screen.getByRole('button', { name: /play held track/i })).toHaveClass('paused');
  });

  test('a different track playing leaves this one unmarked', () => {
    snapshot.currentId = 'someone-else';
    snapshot.state = 'playing';
    draw(held());
    const button = screen.getByRole('button', { name: /play held track/i });
    expect(button).not.toHaveClass('playing');
    expect(button).not.toHaveClass('paused');
  });
});

describe('a track the library does not hold', () => {
  test('gets a download control instead of a play button', () => {
    draw(missing());
    const button = screen.getByRole('button', { name: /get a copy of missing track/i });
    expect(button).toHaveClass('radio-get');
    // Not .track-play, deliberately: the player builds queues from those, and
    // a track with no file cannot be queued.
    expect(button).not.toHaveClass('track-play');
    expect(screen.queryByRole('button', { name: /^play/i })).toBeNull();
  });

  test('quality is what decides it, since that is what the scanner attaches', () => {
    draw(missing({ quality: 'standard' }));
    expect(screen.getByRole('button', { name: /play missing track/i })).toHaveClass('track-play');
  });
});
