// The bug this pins: the lyrics stayed over the page after a menu click.
//
// The lyrics panel takes over the whole content area and the bar that owns it
// never unmounts, so choosing another page from the sidebar changed the page
// underneath and left the lyrics on top of it. Whatever was asked for last
// should be what is on screen.

import { fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { PlayerSnapshot } from './engine.ts';

const snapshot: Partial<PlayerSnapshot> = {};
vi.mock('./usePlayer.ts', () => ({
  usePlayer: () => snapshot,
  player: {
    toggle: vi.fn(), next: vi.fn(), previous: vi.fn(),
    seekFraction: vi.fn(), setVolumePosition: vi.fn(),
  },
}));
// Stand-ins with the real panels' outer markup, which is all the closing
// logic looks at.
vi.mock('./LyricsPanel.tsx', () => ({
  LyricsPanel: ({ open }: { open: boolean }) => (
    <aside className="queue-panel lyrics-panel" aria-label="Lyrics" hidden={!open}>
      <button type="button">A lyric line</button>
    </aside>
  ),
}));
vi.mock('./QueuePanel.tsx', () => ({
  QueuePanel: ({ open }: { open: boolean }) => (
    <aside className="queue-panel" aria-label="Play queue" hidden={!open} />
  ),
}));
vi.mock('../components/LikeButton.tsx', () => ({ LikeButton: () => null }));

const { PlayerBar } = await import('./PlayerBar.tsx');

const base: Partial<PlayerSnapshot> = {
  state: 'playing', overline: 'Local archive', title: 'Hiraeth',
  byline: 'Requiem for a Village', artistId: '', albumId: '', albumName: '',
  artUrl: '', artFallbackUrl: '', initial: 'H', radioSeedId: null,
  queue: [], queueIndex: 0, positionText: '0:00', remainingText: '−4:47',
  progress: 0, canPlay: true, canScrub: true, volumePosition: 1,
  lyrics: { available: true, synced: null, plain: 'words', instrumental: false, source: 'lrclib' } as PlayerSnapshot['lyrics'],
};

const lyricsPanel = () => document.querySelector('.lyrics-panel')!;

const draw = (over: Partial<PlayerSnapshot> = {}, at = '/') => {
  Object.assign(snapshot, base, over);
  render(
    <MemoryRouter initialEntries={[at]}>
      <nav><Link to="/library">Library</Link><button type="button">Search</button></nav>
      <PlayerBar />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Lyrics' }));
  expect(lyricsPanel()).not.toHaveAttribute('hidden');
};

beforeEach(() => { for (const key of Object.keys(snapshot)) delete (snapshot as never)[key]; });

test('choosing another page closes the lyrics', () => {
  draw();
  fireEvent.click(screen.getByRole('link', { name: 'Library' }));
  expect(lyricsPanel()).toHaveAttribute('hidden');
});

test('pressing anything outside the lyrics and the bar closes them', () => {
  draw();
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Search' }));
  expect(lyricsPanel()).toHaveAttribute('hidden');
});

test('the lyrics stay up while using them or the player', () => {
  draw();
  fireEvent.pointerDown(screen.getByRole('button', { name: 'A lyric line' }));
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Next track' }));
  expect(lyricsPanel()).not.toHaveAttribute('hidden');
});

test('a bar link to the page already underneath still closes the lyrics', () => {
  draw({ albumId: 'libalbum-1', albumName: 'Requiem' }, '/album/libalbum-1');
  fireEvent.click(screen.getByRole('link', { name: 'Requiem' }));
  expect(lyricsPanel()).toHaveAttribute('hidden');
});

test('a button activated from the keyboard closes them too', () => {
  draw();
  // Enter or Space on a focused button clicks it without any pointerdown.
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(lyricsPanel()).toHaveAttribute('hidden');
});
