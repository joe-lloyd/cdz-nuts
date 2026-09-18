import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../api/client.ts', () => ({ post, get: vi.fn(), qs: () => '' }));
vi.mock('../api/hooks.ts', () => ({
  useLikedTracks: () => ({ data: [], isPending: false, error: null }),
  useSavedAlbums: () => ({ data: [{ id: 'kept', name: 'Kept', liked: 1 }], isPending: false, error: null }),
  useArtists: () => ({ data: [{ id: 'band', name: 'Band', liked: 1 }, { id: 'other', name: 'Other', liked: 0 }], isPending: false, error: null }),
}));
const { AlbumLikeButton, ArtistLikeButton } = await import('./LikeButton.tsx');

const draw = (node: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>,
);

test('liking an album asks for the album and reports how much of it was queued', async () => {
  post.mockReset().mockResolvedValue({ grabbed: { queued: 9, skipped: 1, lossless: 2 } });
  draw(<AlbumLikeButton album={{ id: 'new', name: 'New record' }} />);
  const heart = screen.getByRole('button', { name: 'Add New record to saved albums' });
  expect(heart).toHaveAttribute('aria-pressed', 'false');
  await userEvent.click(heart);
  await waitFor(() => expect(post).toHaveBeenCalledWith('/api/likes', { id: 'new', liked: true, kind: 'album' }));
  expect(await screen.findByRole('status')).toHaveTextContent('9 songs queued for the archive');
});

test('an artist already in the list shows a filled heart and un-likes on click', async () => {
  post.mockReset().mockResolvedValue({ grabbed: null });
  draw(<ArtistLikeButton artist={{ id: 'band', name: 'Band' }} />);
  const heart = screen.getByRole('button', { name: 'Remove Band from favourite artists' });
  expect(heart).toHaveAttribute('aria-pressed', 'true');
  await userEvent.click(heart);
  await waitFor(() => expect(post).toHaveBeenCalledWith('/api/likes', { id: 'band', liked: false, kind: 'artist' }));
  expect(screen.queryByRole('status')).toBeNull();
});

test('a list row with liked 0 counts as not liked', () => {
  draw(<ArtistLikeButton artist={{ id: 'other', name: 'Other' }} />);
  expect(screen.getByRole('button', { name: 'Add Other to favourite artists' })).toHaveAttribute('aria-pressed', 'false');
});
