import { expect, test, vi } from 'vitest';

class FakeAudio {
  static instances: FakeAudio[] = [];
  preload = ''; volume = 1; paused = true; duration = 0; currentTime = 0; src = '';
  pause = vi.fn(() => { this.paused = true; });
  constructor() { FakeAudio.instances.push(this); }
  addEventListener() {}
  removeEventListener() {}
}

test('Mac output changes pause playback and update both sides of a gapless swap', async () => {
  localStorage.clear();
  vi.stubGlobal('Audio', FakeAudio);
  const speakers = { id: 'speakers', name: 'Speakers', builtInSpeakers: true };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(speakers))));
  const host = window as Window & { __homearpaOutputVolumeEnabled?: boolean };
  host.__homearpaOutputVolumeEnabled = true;
  try {
    const { player } = await import('./engine.ts');
    await vi.waitFor(() => expect(FakeAudio.instances[0]!.volume).toBe(0.52));
    const active = FakeAudio.instances[0]!;
    const standby = FakeAudio.instances[1]!;
    player.setVolumePosition(0.7);
    active.paused = false;
    window.dispatchEvent(new CustomEvent('homearpa-audio-output', {
      detail: { id: 'headphones', name: 'Headphones', builtInSpeakers: false },
    }));
    expect(active.pause).toHaveBeenCalled();
    expect(standby.pause).toHaveBeenCalled();
    expect(active.volume).toBe(0.0625);
    expect(standby.volume).toBe(active.volume);
    expect(player.getSnapshot().volumePosition).toBe(0.25);
    player.setVolumePosition(0.2);
    window.dispatchEvent(new CustomEvent('homearpa-audio-output', { detail: speakers }));
    expect(active.volume).toBeCloseTo(0.49);
    expect(standby.volume).toBe(active.volume);
    expect(player.getSnapshot().volumePosition).toBe(0.7);
  } finally {
    delete host.__homearpaOutputVolumeEnabled;
    vi.unstubAllGlobals();
  }
});
