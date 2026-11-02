import { beforeEach, expect, test, vi } from 'vitest';
import { OutputVolume, QUIET_GAIN } from './outputVolume.ts';

const speakers = { id: 'builtin:ispk', name: 'MacBook Speakers', builtInSpeakers: true };
const headphones = { id: 'builtin:hdpn', name: 'Headphones', builtInSpeakers: false };
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

test('new headphones start quietly, both outputs retain independent levels across restarts', () => {
  const apply = vi.fn(), changed = vi.fn();
  const profiles = new OutputVolume(apply, changed, 0.52);
  expect(apply).toHaveBeenLastCalledWith(QUIET_GAIN);
  profiles.select(speakers);
  expect(apply).toHaveBeenLastCalledWith(0.52);
  profiles.select(headphones);
  expect(changed).toHaveBeenLastCalledWith('Headphones');
  expect(apply).toHaveBeenLastCalledWith(QUIET_GAIN);
  profiles.remember(0.04);
  profiles.select(speakers);
  expect(apply).toHaveBeenLastCalledWith(0.52);
  const restarted = new OutputVolume(apply, changed, 0.52);
  restarted.select(headphones);
  expect(apply).toHaveBeenLastCalledWith(0.04);
});

test('headphones already connected at startup never inherit the global speaker volume', () => {
  const apply = vi.fn();
  const profiles = new OutputVolume(apply, vi.fn(), 1);
  profiles.select(headphones);
  expect(apply.mock.calls.every(([gain]) => gain <= QUIET_GAIN)).toBe(true);
});

test('repeat notifications do not pause playback or overwrite the chosen volume', () => {
  const apply = vi.fn(), changed = vi.fn();
  const profiles = new OutputVolume(apply, changed, 0.52);
  profiles.select(headphones);
  profiles.remember(0);
  apply.mockClear();
  profiles.select(headphones);
  expect(apply).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  profiles.select(speakers);
  profiles.select(headphones);
  expect(apply).toHaveBeenLastCalledWith(0);
});

test('corrupt profiles are ignored and an unreadable route returns to quiet volume', () => {
  localStorage.setItem('music-output-volumes-v1', '{"builtin:hdpn":5,"builtin:ispk":"1"}');
  const apply = vi.fn(), changed = vi.fn();
  const profiles = new OutputVolume(apply, changed, 1);
  profiles.select(headphones);
  expect(apply).toHaveBeenLastCalledWith(QUIET_GAIN);
  profiles.select(null);
  expect(apply).toHaveBeenLastCalledWith(QUIET_GAIN);
  expect(changed).toHaveBeenCalled();
});

test('a late initial response cannot overwrite a newer native route notification', async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolve = r; })));
  const apply = vi.fn();
  const profiles = new OutputVolume(apply, vi.fn(), 1);
  const loading = profiles.load();
  profiles.select(headphones);
  resolve(new Response(JSON.stringify(speakers)));
  await loading;
  expect(apply).toHaveBeenLastCalledWith(QUIET_GAIN);
  vi.unstubAllGlobals();
});

test('an existing mute is preserved for unfamiliar headphones', () => {
  const apply = vi.fn();
  const profiles = new OutputVolume(apply, vi.fn(), 0);
  profiles.select(headphones);
  expect(apply).toHaveBeenLastCalledWith(0);
});
