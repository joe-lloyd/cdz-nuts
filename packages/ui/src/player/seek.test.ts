import { afterEach, expect, test, vi } from 'vitest';

test.each(['fraction', 'seconds', 'seekto', 'seekforward', 'seekbackward'])('the first %s seek overrides a saved resume position', async mode => {
  vi.resetModules();
  localStorage.setItem('music-taste-player-v1', JSON.stringify({
    queue: [{ id: 'resume', name: 'Saved track', artists: 'Fixture', durationMs: 120_000 }],
    queueIndex: 0, resume: { id: 'resume', pos: 30 }, continuationEnabled: false,
  }));
  const created: FakeAudio[] = [];
  const handlers = new Map<string, MediaSessionActionHandler>();
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: {
    setActionHandler: (action: string, handler: MediaSessionActionHandler) => handlers.set(action, handler),
  } });
  let started!: () => void;
  const pendingPlay = new Promise<void>(resolve => { started = resolve; });
  class FakeAudio {
    src = '';
    currentTime = 0;
    duration = 120;
    paused = true;
    volume = 1;
    playbackRate = 1;
    constructor() { created.push(this); }
    addEventListener() {}
    load() { this.currentTime = 0; }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; }
    play() {
      this.paused = false;
      return this.src.startsWith('data:') ? Promise.resolve() : pendingPlay;
    }
  }
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.startsWith('/api/player/resolve') ? {
      available: true, streamUrl: '/track.wav',
      track: { id: 'resume', name: 'Saved track', duration_ms: 120_000 },
    } : {},
  ))));
  const { player } = await import('./engine.ts');
  const playing = player.playAt(0);
  await vi.waitFor(() => expect(player.getSnapshot().canScrub).toBe(true));
  const audio = created.find(el => el.src === '/track.wav')!;
  if (mode === 'fraction') player.seekFraction(0.75);
  else if (mode === 'seconds') player.seekTo(90);
  else if (mode === 'seekto') handlers.get(mode)!({ action: 'seekto', seekTime: 90 });
  else if (mode === 'seekforward') handlers.get(mode)!({ action: 'seekforward', seekOffset: 90 });
  else {
    audio.currentTime = 100;
    handlers.get(mode)!({ action: 'seekbackward', seekOffset: 10 });
  }
  expect(audio.currentTime).toBe(90);
  started();
  await playing;
  expect(audio.currentTime, 'starting playback must not undo the first seek').toBe(90);
});

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
