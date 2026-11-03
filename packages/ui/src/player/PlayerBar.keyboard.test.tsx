import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

// jsdom has no media playback. Keep the real engine and emulate media events.
const playing = new WeakSet<HTMLMediaElement>();
vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) {
  return !playing.has(this);
});
vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (this: HTMLMediaElement) {
  playing.add(this);
  this.dispatchEvent(new Event('play'));
});
vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
  playing.delete(this);
  this.dispatchEvent(new Event('pause'));
});
vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
  available: true, streamUrl: '/fixture.wav',
  track: { id: 'song', name: 'Test song', artists: 'Test artist', duration_ms: 60_000 },
})));

const { player } = await import('./usePlayer.ts');
const { PlayerBar } = await import('./PlayerBar.tsx');

beforeEach(async () => {
  await act(async () => {
    player.setQueue([{ id: 'song', name: 'Test song', artists: 'Test artist', durationMs: 60_000 }], 'song', false);
    await player.playAt(0);
  });
});

test('Space pauses and resumes the song and prevents page scrolling', async () => {
  render(<MemoryRouter><PlayerBar /></MemoryRouter>);
  expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
  expect(fireEvent.keyDown(document.body, { key: ' ', code: 'Space' })).toBe(false);
  expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
  expect(fireEvent.keyDown(document.body, { key: ' ', code: 'Space', repeat: true })).toBe(false);
  expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
  await userEvent.keyboard(' ');
  expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
});

test('Space preserves text entry and focused button activation', async () => {
  render(<MemoryRouter>
    <input aria-label="Search" />
    <textarea aria-label="Notes" />
    <select aria-label="Sort"><option>Name</option></select>
    <div contentEditable suppressContentEditableWarning><span>Editable text</span></div>
    <PlayerBar />
  </MemoryRouter>);
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Search' }), 'two words');
  expect(screen.getByRole('textbox', { name: 'Search' })).toHaveValue('two words');
  for (const target of [screen.getByRole('textbox', { name: 'Notes' }), screen.getByRole('combobox'), screen.getByText('Editable text')]) {
    expect(fireEvent.keyDown(target, { key: ' ' })).toBe(true);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
  }
  expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
  screen.getByRole('button', { name: 'Pause' }).focus();
  await user.keyboard(' ');
  expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
});

test('modified, composing, and handled Space events keep their existing behavior', () => {
  render(<MemoryRouter><PlayerBar /></MemoryRouter>);
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) {
    expect(fireEvent.keyDown(document.body, { key: ' ', ...extra })).toBe(true);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
  }
  const handled = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  handled.preventDefault();
  fireEvent(document.body, handled);
  expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
  fireEvent.keyDown(document.body, { key: ' ' });
  expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
});

test('the shortcut is removed when the player bar unmounts', () => {
  const { unmount } = render(<MemoryRouter><PlayerBar /></MemoryRouter>);
  fireEvent.keyDown(document.body, { key: ' ' });
  expect(player.getSnapshot().state).toBe('paused');
  unmount();
  act(() => { fireEvent.keyDown(document.body, { key: ' ' }); });
  expect(player.getSnapshot().state).toBe('paused');
});
