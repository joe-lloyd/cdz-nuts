import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('../api/client.ts', () => ({
  get: vi.fn().mockResolvedValue({
    songs: [{ id: 'song', name: 'Trains' }],
    artists: [{ id: 'artist', name: 'Porcupine Tree' }],
    albums: [{ id: 'album', name: 'In Absentia' }],
    playlists: [{ id: 'playlist', name: 'Porcupine favourites' }],
  }),
  qs: () => '',
}));
vi.mock('../components/rows.tsx', () => ({ AlbumCell: () => null, SongCard: () => null }));
vi.mock('../components/PlayScope.tsx', () => ({ PlayScope: ({ children }: { children: ReactNode }) => children }));
const { GlobalSearch } = await import('./GlobalSearch.tsx');

test('results list artists first, then albums and playlists, and songs last', async () => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><GlobalSearch>page</GlobalSearch></MemoryRouter>
  </QueryClientProvider>);
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search music' }), 'porc');
  const results = await screen.findByRole('region', { name: 'Search results' });
  await within(results).findByRole('heading', { name: 'Songs' });
  expect(within(results).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent))
    .toEqual(['Artists', 'Albums', 'Playlists', 'Songs']);
});
