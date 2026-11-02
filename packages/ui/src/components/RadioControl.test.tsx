import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import { RadioControl } from './primitives.tsx';
import { SongCard, TrackRow } from './rows.tsx';

vi.mock('../player/usePlayer.ts', () => ({ usePlayer: () => ({ currentId: null, state: 'idle' }), player: {} }));
vi.mock('../player/engine.ts', () => ({ player: {} }));
vi.mock('./LikeButton.tsx', () => ({ LikeButton: () => null }));

test.each(['libtrack-song', 'spotify-song', 'local-song', 'setlist:100%/song', 'radio-song'])('every song type gets a shareable radio link: %s', id => {
  render(<MemoryRouter><RadioControl track={{ id, name: 'Seed', artists: 'Artist' }} /></MemoryRouter>);
  const link = screen.getByRole('link', { name: 'Radio from Seed' });
  expect(link).toHaveAttribute('href', `/radio/track/${encodeURIComponent(id)}?artist=Artist&title=Seed`);
  expect(link).toHaveTextContent('Radio');
});

test.each([SongCard, TrackRow])('both song cards and rows expose radio', Component => {
  render(<MemoryRouter><Component track={{ id: 'spotify-song', name: 'Seed', artists: 'Artist' }} /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Radio from Seed' })).toBeInTheDocument();
});
