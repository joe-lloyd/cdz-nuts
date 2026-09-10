import { render, screen, waitFor, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

const { getFresh } = vi.hoisted(() => ({ getFresh: vi.fn() }));
vi.mock('../api/client.ts', async (original) => ({
  ...(await original<typeof import('../api/client.ts')>()),
  getFresh,
  get: vi.fn().mockResolvedValue({ digest: 'f592c3db6abed952' }),
}));

const { ApiError } = await import('../api/client.ts');
const { useDesktop } = await import('../api/hooks.ts');
const { VersionChip } = await import('./Shell.tsx');

const wrap = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

test('a 404 on the desktop endpoint means "this is the web build", not an error', async () => {
  getFresh.mockRejectedValueOnce(new ApiError('no such desktop endpoint', 404));
  const { result } = renderHook(() => useDesktop(), { wrapper: wrap });
  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(result.current.data).toBeNull();
  expect(result.current.error).toBeNull();
});

test('a real failure is still a failure, so a broken shell does not read as a browser', async () => {
  getFresh.mockRejectedValueOnce(new ApiError('the app is still starting', 503));
  const { result } = renderHook(() => useDesktop(), { wrapper: wrap });
  await waitFor(() => expect(result.current.isError).toBe(true));
});

test('the desktop app shows its version', async () => {
  getFresh.mockResolvedValueOnce({ version: '0.4.2', update_pending: false });
  render(<VersionChip />, { wrapper: wrap });
  expect(await screen.findByText('v0.4.2')).toBeInTheDocument();
});

test('a waiting update is visible without opening anything', async () => {
  getFresh.mockResolvedValueOnce({ version: '0.4.2', update_pending: true });
  render(<VersionChip />, { wrapper: wrap });
  const chip = await screen.findByText('v0.4.2');
  expect(chip.className).toContain('has-update');
  expect(chip.title).toMatch(/waiting/i);
});

test('the web build shows the front end it was served, not a fake version', async () => {
  getFresh.mockRejectedValueOnce(new ApiError('no such desktop endpoint', 404));
  render(<VersionChip />, { wrapper: wrap });
  expect(await screen.findByText('f592c3d')).toBeInTheDocument();
});
