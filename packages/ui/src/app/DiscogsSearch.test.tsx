import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

const { get, post, notify } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), notify: vi.fn() }));
vi.mock('../api/client.ts', async (original) => ({ ...await original<typeof import('../api/client.ts')>(), get, post }));
vi.mock('../player/usePlayer.ts', () => ({ player: { notify } }));
const { ApiError } = await import('../api/client.ts');
const { DiscogsSearch } = await import('./DiscogsSearch.tsx');

const lanterns = { kind: 'master', id: 501, title: 'Hollow Lanterns', artist: 'The Quiet Ferns', year: 2019, image: null, format: 'CD', library: null };
const ferns = { id: 77, name: 'The Quiet Ferns', image: null, library: null };

function draw(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(<QueryClientProvider client={client}><MemoryRouter><DiscogsSearch term="quiet ferns" hasLocal={false} /></MemoryRouter></QueryClientProvider>);
  return client;
}

beforeEach(() => { get.mockReset(); post.mockReset(); notify.mockReset(); });

test('Discogs is only asked once the user chooses to search it', async () => {
  get.mockResolvedValue({ artists: [ferns], albums: [lanterns] });
  draw();
  expect(screen.getByText(/Nothing in the library yet/)).toBeInTheDocument();
  expect(get).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Search Discogs' }));
  await screen.findByRole('button', { name: 'Add Hollow Lanterns to library' });
  expect(get).toHaveBeenCalledWith('/api/discogs/search?q=quiet+ferns', expect.anything());
  expect(screen.getByRole('button', { name: 'Add The Quiet Ferns to library' })).toBeInTheDocument();
});

test('adding an album marks it held, links to it and refreshes the library', async () => {
  get.mockImplementation((path: string) => path.startsWith('/api/discogs/album')
    ? Promise.resolve({ album: { ...lanterns, label: null, tracks: [{ position: '1', title: 'Moth Light', durationMs: 245000 }] } })
    : Promise.resolve({ artists: [], albums: [lanterns] }));
  post.mockResolvedValue({ kind: 'master', id: 'discogs-master:501', added: true });
  const client = draw();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  await userEvent.click(screen.getByRole('button', { name: 'Search Discogs' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Show tracks of Hollow Lanterns' }));
  const tracks = await screen.findByRole('region', { name: 'Tracks of Hollow Lanterns' });
  expect(await within(tracks).findByText('Moth Light')).toBeInTheDocument();
  expect(within(tracks).getByText('4:05')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Add Hollow Lanterns to library' }));
  expect(post).toHaveBeenCalledWith('/api/discogs/add', { kind: 'master', id: 501 });
  const link = await screen.findByRole('link', { name: 'Open Hollow Lanterns in your library' });
  expect(link).toHaveAttribute('href', '/album/discogs-master%3A501');
  expect(notify).toHaveBeenCalledWith('Added Hollow Lanterns to your library');
  for (const key of ['global-search', 'albums', 'artists']) expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
});

test('held entries show as in the library with no add button', async () => {
  get.mockResolvedValue({ artists: [{ ...ferns, library: 'sp-ferns' }], albums: [] });
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Search Discogs' }));
  expect(await screen.findByRole('link', { name: 'Open The Quiet Ferns in your library' })).toHaveAttribute('href', '/artist/sp-ferns');
  expect(screen.queryByRole('button', { name: /Add .* to library/ })).toBeNull();
});

test('a Discogs problem is explained, keeps local search, and can be retried', async () => {
  get.mockRejectedValueOnce(new ApiError('Discogs is not configured on this server', 503));
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Search Discogs' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Discogs is not configured on this server. Whoever runs the server can add a Discogs token to switch it on. Your library search still works.');
  get.mockRejectedValueOnce(new ApiError('Discogs rate limit reached. Try again in 7 seconds.', 429));
  await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Discogs rate limit reached. Try again in 7 seconds. Your library search still works.'));
  get.mockResolvedValueOnce({ artists: [], albums: [] });
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Discogs has nothing for “quiet ferns”.')).toBeInTheDocument();
});

test('a failed add says why and leaves the button to try again', async () => {
  get.mockResolvedValue({ artists: [], albums: [lanterns] });
  post.mockRejectedValue(new ApiError('Discogs is unavailable right now', 502));
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Search Discogs' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Add Hollow Lanterns to library' }));
  await waitFor(() => expect(notify).toHaveBeenCalledWith('Could not add Hollow Lanterns. Discogs is unavailable right now. Your library search still works.', true));
  expect(screen.getByRole('button', { name: 'Add Hollow Lanterns to library' })).toBeEnabled();
});

test('a discography cut short says it may be incomplete, and an empty one does not claim Discogs has none', async () => {
  const discography = (albums: unknown[], truncated: boolean) => ({ artist: { ...ferns, profile: null }, albums, truncated });
  get.mockImplementation((path: string) => Promise.resolve(path.startsWith('/api/discogs/artist')
    ? discography([lanterns], true)
    : { artists: [ferns], albums: [] }));
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Search Discogs' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Show albums by The Quiet Ferns' }));
  const panel = await screen.findByRole('region', { name: 'Albums by The Quiet Ferns' });
  expect(await within(panel).findByText('Hollow Lanterns')).toBeInTheDocument();
  expect(within(panel).getByText(/this list may be incomplete/)).toBeInTheDocument();
});

test('an empty discography cut short is not reported as no albums', async () => {
  get.mockImplementation((path: string) => Promise.resolve(path.startsWith('/api/discogs/artist')
    ? { artist: { ...ferns, profile: null }, albums: [], truncated: true }
    : { artists: [ferns], albums: [] }));
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Search Discogs' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Show albums by The Quiet Ferns' }));
  const panel = await screen.findByRole('region', { name: 'Albums by The Quiet Ferns' });
  expect(await within(panel).findByText(/The listing was cut short, so Discogs may have more/)).toBeInTheDocument();
  expect(within(panel).queryByText(/Discogs lists no albums/)).toBeNull();
});

test('a complete empty discography says Discogs lists no albums', async () => {
  get.mockImplementation((path: string) => Promise.resolve(path.startsWith('/api/discogs/artist')
    ? { artist: { ...ferns, profile: null }, albums: [], truncated: false }
    : { artists: [ferns], albums: [] }));
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Search Discogs' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Show albums by The Quiet Ferns' }));
  const panel = await screen.findByRole('region', { name: 'Albums by The Quiet Ferns' });
  expect(await within(panel).findByText('Discogs lists no albums for The Quiet Ferns.')).toBeInTheDocument();
  expect(within(panel).queryByText(/may be incomplete|cut short/)).toBeNull();
});
