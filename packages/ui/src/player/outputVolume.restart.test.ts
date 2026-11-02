import { expect, test, vi } from 'vitest';
import { OutputVolume, QUIET_GAIN } from './outputVolume.ts';

class FakeAudio {
  volume = 1; paused = true; duration = 0; currentTime = 0; src = ''; preload = '';
  addEventListener() {}
  removeEventListener() {}
}

test('saving a headphone level before visiting speakers preserves speaker migration across restart', async () => {
  localStorage.clear();
  localStorage.setItem('music-taste-player-v1', JSON.stringify({ volume: 0.8 }));
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    id: 'headphones', name: 'Headphones', builtInSpeakers: false,
  }))));
  const host = window as Window & { __homearpaOutputVolumeEnabled?: boolean };
  host.__homearpaOutputVolumeEnabled = true;
  try {
    const { player } = await import('./engine.ts');
    await vi.waitFor(() => expect(localStorage.getItem('music-output-volumes-v1')).toContain('headphones'));
    expect(player.getSnapshot().volumePosition).toBe(Math.sqrt(QUIET_GAIN));
    player.setVolumePosition(0.2);
    const saved = JSON.parse(localStorage.getItem('music-taste-player-v1')!);
    expect(saved.volume).toBe(0.8);
    const apply = vi.fn();
    const restarted = new OutputVolume(apply, vi.fn(), saved.volume);
    restarted.select({ id: 'speakers', name: 'Speakers', builtInSpeakers: true });
    expect(apply).toHaveBeenLastCalledWith(0.8);
    restarted.select({ id: 'headphones', name: 'Headphones', builtInSpeakers: false });
    expect(apply).toHaveBeenLastCalledWith(0.2 ** 2);
  } finally {
    delete host.__homearpaOutputVolumeEnabled;
    vi.unstubAllGlobals();
  }
});
