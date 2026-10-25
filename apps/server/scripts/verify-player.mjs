// Run after installing dependencies in both this repo and ui/.
// Exercises the real audio engine with short WAV tracks and no archive access.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const requireUi = createRequire(new URL('../../../packages/ui/package.json', import.meta.url));
// esbuild comes in through vite, the UI's bundler.
const { build } = createRequire(requireUi.resolve('vite'))('esbuild');
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../../../packages/ui/src/player/engine.ts', import.meta.url))],
  bundle: true, format: 'iife', globalName: 'MusicPlayer', write: false,
});
const wav = Buffer.alloc(44 + 8000 * 2 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end('<script src="/engine.js"></script>');
  if (url.pathname === '/engine.js') {
    res.setHeader('content-type', 'application/javascript');
    return res.end(outputFiles[0].contents);
  }
  if (url.pathname === '/tone.wav') {
    let body = wav;
    res.setHeader('content-type', 'audio/wav');
    res.setHeader('accept-ranges', 'bytes');
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2] || wav.length - 1), wav.length - 1);
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${wav.length}`);
      body = wav.subarray(start, end + 1);
    }
    res.setHeader('content-length', body.length);
    return res.end(body);
  }
  res.setHeader('content-type', 'application/json');
  const id = url.searchParams.get('id');
  res.end(JSON.stringify(url.pathname === '/api/player/resolve' ? {
    available: true, streamUrl: `/tone.wav?id=${id}`,
    track: { id, name: id, artists: 'Fixture', duration_ms: 2000 },
  } : {}));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  for (const failure of ['none', 'reject', 'stall']) {
    const page = await browser.newPage();
    await page.addInitScript(mode => {
      window.played = [];
      const play = HTMLMediaElement.prototype.play;
      let injected = false;
      HTMLMediaElement.prototype.play = function () {
        if (!injected && this.src.endsWith('id=b') && mode !== 'none') {
          injected = true;
          return mode === 'reject'
            ? Promise.reject(new DOMException('Playback refused', 'NotAllowedError'))
            : new Promise(() => {});
        }
        this.addEventListener('timeupdate', () => {
          const id = new URL(this.src).searchParams.get('id');
          if (id && this.currentTime > 0.3 && !window.played.includes(id)) window.played.push(id);
        }, { once: false });
        return play.call(this);
      };
    }, failure);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      const p = MusicPlayer.player;
      p.setQueue(['a', 'b', 'c'].map(id => ({ id, name: id, artists: 'Fixture', durationMs: 2000 })), 'a', false);
      void p.playAt(0);
    });
    await page.waitForFunction(() => window.played.includes('c'), null, { timeout: 20000 });
    assert.deepEqual(await page.evaluate(() => window.played), ['a', 'b', 'c']);
    console.log(`PASS: three tracks made playback progress, second-track failure=${failure}`);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
