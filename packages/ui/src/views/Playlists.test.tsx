import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

const { post } = vi.hoisted(() => ({ post: vi.fn().mockResolvedValue({ id: 'local-playlist:new' }) }));
vi.mock('../api/client.ts', () => ({ post, get: vi.fn(), qs: () => '' }));
vi.mock('../api/hooks.ts', () => ({
  usePlaylists: () => ({ data: [{ id: 'local-playlist:one', name: 'Mine', source: 'local', synced_tracks: 0 }], isPending: false }),
  usePlaylistTracks: () => ({ data: [{ id: 'one', name: 'Even Less' }, { id: 'two', name: 'Dark Matter' }], isPending: false }),
}));
vi.mock('../components/rows.tsx', () => ({ TrackRow: () => null }));
vi.mock('../components/PlayScope.tsx', () => ({ PlayScope: ({ children }: { children: ReactNode }) => children }));
const { Playlists, PlaylistDetail } = await import('./Library.tsx');

function draw(detail = false) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[detail ? '/playlist/local-playlist:one' : '/playlists']}>
      <Routes><Route path="/playlists" element={<Playlists />} /><Route path="/playlist/:id" element={<PlaylistDetail />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>);
}

test('empty local playlists stay visible and a new playlist can be created', async () => {
  post.mockClear();
  draw();
  expect(screen.getByRole('link', { name: 'Mine' })).toBeInTheDocument();
  await userEvent.type(screen.getByRole('textbox', { name: 'New playlist name' }), 'Road trip');
  await userEvent.click(screen.getByRole('button', { name: 'Create playlist' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/api/local-playlists', { name: 'Road trip', trackIds: [] }));
});

test('reordering and removing songs saves the requested order', async () => {
  post.mockClear();
  draw(true);
  await userEvent.click(screen.getByText('Edit playlist'));
  await userEvent.click(screen.getByRole('button', { name: 'Move Dark Matter up' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/api/local-playlists', expect.objectContaining({ trackIds: ['two', 'one'] })));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Even Less' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: 'Remove Even Less' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/api/local-playlists', expect.objectContaining({ trackIds: ['two'] })));
});
