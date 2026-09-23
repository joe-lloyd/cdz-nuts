import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

const reconnect = vi.fn(() => Promise.resolve());
const refetch = vi.fn(() => Promise.resolve());
let libraryStatus: { state: string } | undefined;
let statusError = false;
let canReconnect = true;

vi.mock('../api/hooks.ts', () => ({
  useDesktop: () => ({ data: { version: '0.5.0', update_pending: false } }),
  usePlayerStatus: () => ({ data: libraryStatus, isError: statusError, isPending: false, refetch }),
}));

vi.mock('../player/usePlayer.ts', () => ({
  player: { reconnect },
  usePlayer: () => ({ canReconnect }),
}));

const { ReconnectButton } = await import('./Shell.tsx');

test('a failed stream offers reconnect even while library status is cached as ready', async () => {
  libraryStatus = { state: 'ready' };
  statusError = false;
  canReconnect = true;
  render(<ReconnectButton />);

  await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

  expect(reconnect).toHaveBeenCalledOnce();
  expect(refetch).toHaveBeenCalledOnce();
  expect(screen.queryByText(/wake eliot/i)).toBeNull();
});

test('a missing track does not offer a connection fix while the library is ready', () => {
  libraryStatus = { state: 'ready' };
  statusError = false;
  canReconnect = false;
  render(<ReconnectButton />);

  expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
});
