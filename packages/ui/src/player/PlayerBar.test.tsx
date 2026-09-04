import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { PlayerSnapshot } from './engine.ts';

// Same stubbing as PlayControl: the engine owns real audio elements, so what
// is under test is purely the mapping from a snapshot to markup.
const snapshot: Partial<PlayerSnapshot> = {};
vi.mock('./usePlayer.ts', () => ({
  usePlayer: () => snapshot,
  player: {
    toggle: vi.fn(), next: vi.fn(), previous: vi.fn(),
    seekFraction: vi.fn(), setVolumePosition: vi.fn(),
  },
}));
// The panels reach for the engine and browser APIs of their own; neither has
// anything to do with whether the bar's copy is linked.
vi.mock('./QueuePanel.tsx', () => ({ QueuePanel: () => null }));
vi.mock('./LyricsPanel.tsx', () => ({ LyricsPanel: () => null }));

const { PlayerBar } = await import('./PlayerBar.tsx');

const base: Partial<PlayerSnapshot> = {
  state: 'playing', overline: 'Local archive · Jellyfin', title: 'The 78',
  byline: 'Steven Wilson', artistId: '', albumId: '', albumName: '',
  artUrl: '', artFallbackUrl: '', initial: 'T', radioSeedId: null,
  queue: [], queueIndex: 0, positionText: '0:00', remainingText: '−4:47',
  progress: 0, canPlay: true, canScrub: true, lyrics: null, volumePosition: 1,
};

const draw = (over: Partial<PlayerSnapshot> = {}) => {
  Object.assign(snapshot, base, over);
  return render(<MemoryRouter><PlayerBar /></MemoryRouter>);
};

beforeEach(() => { for (const key of Object.keys(snapshot)) delete (snapshot as never)[key]; });

test('the artist in the bar is a link to their page', () => {
  // The bar names the artist on every screen in the app, and it was the one
  // place the name was dead text.
  draw({ artistId: '4X42BfuhWCAZ2swiVze9O0' });
  expect(screen.getByRole('link', { name: 'Steven Wilson' }))
    .toHaveAttribute('href', '/artist/4X42BfuhWCAZ2swiVze9O0');
});

test('an artist we hold no page for is still named, just not linked', () => {
  // Library-only artists (Mogwai, Squarepusher) resolve to no id at all.
  // A link to nowhere would be worse than plain text.
  draw({ byline: 'Squarepusher', artistId: '' });
  expect(screen.getByText('Squarepusher')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Squarepusher' })).toBeNull();
});

test('the album link is labelled with the page it actually opens', () => {
  // "The 78" is tagged `Harmony Korine` but lives on the Singles shelf, so the
  // bar used to offer a link reading "Harmony Korine" that led to a page
  // headed "Singles" -- and from that page the click did nothing at all.
  draw({ albumId: 'libalbum-8131dcab5a2a84e3', albumName: 'Singles' });
  const link = screen.getByRole('link', { name: 'Singles' });
  expect(link).toHaveAttribute('href', '/album/libalbum-8131dcab5a2a84e3');
});

test('both links can be present at once without merging into one', () => {
  draw({ artistId: 'A1', albumId: 'libalbum-1', albumName: 'Insurgentes' });
  expect(screen.getByRole('link', { name: 'Steven Wilson' })).toHaveAttribute('href', '/artist/A1');
  expect(screen.getByRole('link', { name: 'Insurgentes' })).toHaveAttribute('href', '/album/libalbum-1');
});
