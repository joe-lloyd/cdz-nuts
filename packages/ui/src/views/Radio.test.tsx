import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { RadioControl } from '../components/primitives.tsx';
import { Station } from './Radio.tsx';

vi.mock('../player/usePlayer.ts', () => ({
  usePlayer: () => ({ currentId: null, state: 'idle' }),
  player: { append: vi.fn(), notify: vi.fn() },
}));
vi.mock('../player/engine.ts', () => ({ player: { append: vi.fn(), setQueue: vi.fn(), playAt: vi.fn() } }));
vi.mock('../components/LikeButton.tsx', () => ({ LikeButton: () => null }));
afterEach(() => { vi.unstubAllGlobals(); });

test.each(['spotify-song', 'setlist:100%/song'])('song radio navigates immediately and loads the API playlist for %s', async id => {
  let finish!: (response: Response) => void;
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/radio?')) return new Promise<Response>(resolve => { finish = resolve; });
    return Promise.resolve(new Response('{}'));
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/']}><Routes>
    <Route path="/" element={<RadioControl track={{ id, name: 'Song / 100%', artists: 'Artist & Guest' }} />} />
    <Route path="/radio/:kind/*" element={<Station />} />
  </Routes></MemoryRouter></QueryClientProvider>);
  await userEvent.click(screen.getByRole('link', { name: 'Radio from Song / 100%' }));
  expect(screen.getByRole('heading', { name: 'Song radio' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Finding related songs with ListenBrainz');
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const request = new URL(fetchMock.mock.calls[0]![0], 'https://music.home.arpa');
  expect(request.searchParams.get('from')).toBe(id);
  expect(request.searchParams.get('title')).toBe('Song / 100%');
  expect(request.searchParams.get('artist')).toBe('Artist & Guest');
  finish(new Response(JSON.stringify({
    seedTrack: { title: 'Song / 100%', artist: 'Artist & Guest' }, source: 'similar', owned: 1, fresh: 1,
    tracks: [
      { id: 'libtrack-related', name: 'Related in library', artists: 'Related Artist', quality: 'lossless' },
      { id: 'radio-new', name: 'Related from the API', artists: 'New Artist', pending: true, recording_mbid: 'recording-id' },
    ],
  })));
  expect(await screen.findByRole('heading', { name: 'Songs like Song / 100%' })).toBeInTheDocument();
  expect(screen.getByText('Related in library')).toBeInTheDocument();
  expect(screen.getByText('Related from the API')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Radio from Related from the API' })).toHaveAttribute('href', expect.stringContaining('mbid=recording-id'));
});

test.each([{ error: 'Temporary service failure', tracks: [] }, { tracks: [] }])('empty station responses offer retry: %j', async response => {
  const fetchMock = vi.fn(async () => Response.json(response));
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/radio/artist/Artist']}><Routes>
    <Route path="/radio/:kind/*" element={<Station />} />
  </Routes></MemoryRouter></QueryClientProvider>);
  await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});
