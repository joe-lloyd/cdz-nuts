import { expect, test, vi } from 'vitest';

class FakeAudio {
  static instances: FakeAudio[] = [];
  preload = ''; volume = 1; paused = true; duration = 0; currentTime = 0; src = '';
  pause = vi.fn(() => { this.paused = true; });
  play = vi.fn(async () => { this.paused = false; });
  load() {}
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  constructor() { FakeAudio.instances.push(this); }
  addEventListener() {}
  removeEventListener() {}
}

test('Mac output changes pause playback and update both sides of a gapless swap', async () => {
  localStorage.clear();
  vi.stubGlobal('Audio', FakeAudio);
  const speakers = { id: 'speakers', name: 'Speakers', builtInSpeakers: true };
  let finishInitial!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finishInitial = resolve; })));
  const host = window as Window & { __homearpaOutputVolumeEnabled?: boolean };
  host.__homearpaOutputVolumeEnabled = true;
  try {
    const { player } = await import('./engine.ts');
    const active = FakeAudio.instances[0]!;
    const standby = FakeAudio.instances[1]!;
    // Playback can start while native output discovery is still pending.
    expect(active.volume).toBe(0.0625);
    active.paused = false;
    const gainsAtPause: number[] = [];
    active.pause.mockImplementation(() => { gainsAtPause.push(active.volume); active.paused = true; });
    finishInitial(new Response(JSON.stringify(speakers)));
    await vi.waitFor(() => expect(active.volume).toBe(0.52));
    expect(gainsAtPause[0]).toBe(0.0625);
    expect(active.paused).toBe(true);
    expect(standby.pause).toHaveBeenCalled();
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

    // An output change while resolving a track must leave a usable Play button.
    let finishResolve!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { finishResolve = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    player.setQueue([{ id: 'test-track', name: 'Test track', artists: 'Test artist', durationMs: 1000 }], 'test-track', false);
    const pending = player.playAt(0);
    expect(player.getSnapshot().state).toBe('loading');
    window.dispatchEvent(new CustomEvent('homearpa-audio-output', {
      detail: { id: 'headphones', name: 'Headphones', builtInSpeakers: false },
    }));
    expect(player.getSnapshot().state).toBe('paused');
    expect(player.getSnapshot().canPlay).toBe(true);
    finishResolve(new Response(JSON.stringify({ available: false })));
    await pending;
    expect(player.getSnapshot().state).toBe('paused');
    player.toggle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    finishResolve(new Response(JSON.stringify({ available: false })));
    await Promise.resolve();
  } finally {
    delete host.__homearpaOutputVolumeEnabled;
    vi.unstubAllGlobals();
  }
});
