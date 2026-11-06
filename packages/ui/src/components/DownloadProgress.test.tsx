import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { DownloadProgressProvider } from './DownloadProgress.tsx';
import { PlayControl } from './primitives.tsx';
import type { Track } from '../api/types.ts';

const play = vi.hoisted(() => vi.fn());
vi.mock('./PlayScope.tsx', () => ({ usePlayFromScope: () => play }));
vi.mock('../player/usePlayer.ts', () => ({ usePlayer: () => ({ currentId: null, state: 'idle' }), player: { notify: vi.fn() } }));
const track: Track = { id: 'spotify-droplet', name: 'Droplet', artists: 'Sevish', duration_ms: 237_092 };
let state: Record<string, unknown>;
let requests: { path: string; body: { tracks?: unknown[] } }[];
let client: QueryClient;
beforeEach(() => {
  play.mockClear(); requests = [];
  state = { ready: false, stage: 'not-requested', status: 'not-queued', phase: null };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests.push({ path, body });
    if (path === '/api/tracks/want') {
      state = { ready: false, stage: 'downloading', status: 'pending_source', phase: 'source' };
      return Response.json({ detail: 'Queued' });
    }
    return Response.json({ results: body.tracks.map((t: { clientKey: string; artist: string; title: string }) => ({ key: t.clientKey, ...state })) });
  }));
});
afterEach(() => { client.clear(); vi.unstubAllGlobals(); });
function draw(duplicates = false) {
  return render(<QueryClientProvider client={client}><MemoryRouter><DownloadProgressProvider>
    <PlayControl track={track} />{duplicates ? <PlayControl track={track} /> : null}
  </DownloadProgressProvider></MemoryRouter></QueryClientProvider>);
}
async function update(next: Record<string, unknown>) {
  state = next;
  await act(async () => { await client.invalidateQueries({ queryKey: ['download-progress'] }); });
}

test('a download changes from queued through YouTube and indexing into a working play button without a reload', async () => {
  draw();
  await waitFor(() => expect(requests.some(r => r.path === '/api/radio/resolve')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Get a copy of Droplet' }));
  await screen.findByText('Queued for download');
  expect(screen.getByRole('button', { name: 'Get a copy of Droplet' })).toBeDisabled();
  await update({ ready: false, stage: 'downloading', status: 'working', phase: 'source' });
  await screen.findByText('Downloading from YouTube…');
  await update({ ready: false, stage: 'indexing', status: 'queued', phase: 'upgrade' });
  await screen.findByText('Downloaded · preparing playback');
  // Lossless hunting remains queued; the first playable file is enough.
  await update({ ready: true, stage: 'ready', status: 'queued', phase: 'upgrade' });
  fireEvent.click(await screen.findByRole('button', { name: 'Play Droplet' }));
  expect(play).toHaveBeenCalledWith(track);
  expect(requests.filter(r => r.path === '/api/tracks/want')).toHaveLength(1);
});

test('an already downloaded but unscanned song is playable on initial load', async () => {
  state = { ready: true, stage: 'ready', status: 'upgraded', phase: 'upgrade' };
  draw();
  expect(await screen.findByRole('button', { name: 'Play Droplet' })).toBeEnabled();
  expect(requests.some(r => r.path === '/api/tracks/want')).toBe(false);
});

test('an exhausted source job explains the failure and allows another request', async () => {
  state = { ready: false, stage: 'downloading', status: 'exhausted', phase: 'source', error: 'No source found' };
  draw();
  await screen.findByText('Download stopped · retry');
  const button = screen.getByRole('button', { name: 'Get a copy of Droplet' });
  expect(button).toBeEnabled(); expect(button).toHaveAttribute('title', 'No source found');
  fireEvent.click(button);
  await screen.findByText('Queued for download');
});

test('duplicate rows share one lookup and unmount cancels polling', async () => {
  const view = draw(true);
  await waitFor(() => expect(requests.length).toBeGreaterThan(0));
  expect(requests.every(r => r.body.tracks?.length === 1)).toBe(true);
  view.unmount();
  expect(client.getQueryCache().getAll().every(q => q.getObserversCount() === 0)).toBe(true);
});

test('progress stays visible while a changed list waits for its new batch', async () => {
  state = { ready: false, stage: 'downloading', status: 'working', phase: 'source' };
  let finish!: (response: Response) => void;
  const original = fetch;
  vi.stubGlobal('fetch', vi.fn((path: string, init: RequestInit) => {
    if (JSON.parse(String(init.body)).tracks?.length === 2) return new Promise<Response>(resolve => { finish = resolve; });
    return original(path, init);
  }));
  function List() {
    const [extra, setExtra] = useState(false);
    return <><button onClick={() => setExtra(true)}>Add row</button><PlayControl track={track} />
      {extra ? <PlayControl track={{ ...track, id: 'other', name: 'Another song' }} /> : null}</>;
  }
  render(<QueryClientProvider client={client}><MemoryRouter><DownloadProgressProvider><List /></DownloadProgressProvider></MemoryRouter></QueryClientProvider>);
  await screen.findByText('Downloading from YouTube…');
  fireEvent.click(screen.getByText('Add row'));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(screen.getByText('Downloading from YouTube…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Get a copy of Droplet' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Get a copy of Another song' })).toBeEnabled();
  await act(async () => { finish(Response.json({ results: [] })); });
});

test('same-title recordings keep independent keys and send their MBID and matching hints', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ path: '/api/radio/resolve', body });
    return Response.json({ results: body.tracks.map((t: { clientKey: string; album: string }) => ({
      key: t.clientKey, ready: t.album === 'Studio', stage: 'ready', status: 'queued', phase: 'upgrade',
    })) });
  }));
  render(<QueryClientProvider client={client}><MemoryRouter><DownloadProgressProvider>
    <PlayControl track={{ ...track, album: 'Studio', recording_mbid: 'studio-recording' }} />
    <PlayControl track={{ ...track, id: 'live', album: 'Live', duration_ms: 500000 }} />
    <PlayControl track={{ ...track, id: 'other-take', album: 'Studio', duration_ms: 200000 }} />
  </DownloadProgressProvider></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Play Droplet' })).toHaveLength(2));
  expect(screen.getByRole('button', { name: 'Get a copy of Droplet' })).toBeDisabled();
  const specs = requests.at(-1)!.body.tracks as { clientKey: string; recordingMbid: string | null; album: string; durationMs: number }[];
  expect(new Set(specs.map(t => t.clientKey)).size).toBe(3);
  expect(specs.find(t => t.recordingMbid)?.recordingMbid).toBe('studio-recording');
  expect(specs.find(t => t.album === 'Live')?.durationMs).toBe(500000);
});


test('manual download requests retain recording identity', async () => {
  render(<QueryClientProvider client={client}><MemoryRouter><DownloadProgressProvider>
    <PlayControl track={{ ...track, recording_mbid: 'recording-id', release_mbid: 'release-id' }} />
  </DownloadProgressProvider></MemoryRouter></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Get a copy of Droplet' }));
  await waitFor(() => expect(requests.some(r => r.path === '/api/tracks/want')).toBe(true));
  expect(requests.find(r => r.path === '/api/tracks/want')?.body).toMatchObject({ recordingMbid: 'recording-id', releaseMbid: 'release-id' });
});
