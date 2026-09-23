import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

const reconnect = vi.fn(() => Promise.resolve());
const refetch = vi.fn(() => Promise.resolve());

vi.mock('../api/hooks.ts', () => ({
  useDesktop: () => ({ data: { version: '0.5.0', update_pending: false } }),
  usePlayerStatus: () => ({ data: undefined, isError: true, isPending: false, refetch }),
}));

vi.mock('../player/usePlayer.ts', () => ({
  player: { reconnect },
  usePlayer: () => ({ state: 'error' }),
}));

const { ReconnectButton } = await import('./Shell.tsx');

test('a disconnected desktop offers to reconnect instead of waking the server', async () => {
  render(<ReconnectButton />);

  await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

  expect(reconnect).toHaveBeenCalledOnce();
  expect(refetch).toHaveBeenCalledOnce();
  expect(screen.queryByText(/wake eliot/i)).toBeNull();
});
