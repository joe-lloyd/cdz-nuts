// A harness that runs the REAL legacy player against the REAL legacy markup.
//
// The point of these tests is to pin behaviour that exists, so the React engine
// can be checked against it rather than against my reading of it. That only
// works if the thing under test is the actual shipped file -- so this loads
// legacy/index.html for its DOM and evaluates legacy/player.js against it,
// rather than reconstructing either.
//
// When the port is finished and the same tests pass against the new engine,
// this harness goes away with legacy/.

import { readFileSync } from 'node:fs';
import path from 'node:path';

// Resolved from the project root, not from import.meta.url: under the jsdom
// environment import.meta.url is an http:// URL, so fileURLToPath rejects it.
const LEGACY_HTML = path.resolve(process.cwd(), 'legacy/index.html');
const LEGACY_PLAYER = path.resolve(process.cwd(), 'legacy/player.js');

export interface Track {
  id: string;
  name: string;
  artists: string;
  durationMs: number;
  albumId?: string;
  imageUrl?: string;
}

/** What a test can drive and observe. */
export interface Harness {
  /** The visible audio element -- the one in the document. */
  audio: HTMLAudioElement;
  /** Every audio element the player is using, active or pre-buffering. */
  allAudio: () => HTMLAudioElement[];
  bar: HTMLElement;
  /** Append tracks the way the station view does, via the exposed global. */
  append: (tracks: Track[], options?: Record<string, unknown>) => void;
  has: (id: string) => boolean;
  /** Build a row of play buttons the way the views do, then click one. */
  playFromRows: (tracks: Track[], index: number) => void;
  click: (selector: string) => void;
  /** Move playback to a position, firing timeupdate as the browser would. */
  seekTo: (seconds: number) => void;
  storage: () => Record<string, unknown> | null;
  /** Requests the player made, in order. */
  calls: string[];
}

/** Queue up what `fetch` should answer, by URL substring. */
export type Responder = (url: string) => unknown;

/**
 * jsdom implements no media playback at all: play/pause/load throw
 * "Not implemented", and currentTime/duration are inert. Give the prototype
 * just enough behaviour that the player's own logic can run and be observed --
 * deliberately not a full media element, only what the player touches.
 */
function stubMediaElement() {
  const proto = window.HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  proto.play = function play(this: HTMLAudioElement) {
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  };
  proto.pause = function pause(this: HTMLAudioElement) {
    Object.defineProperty(this, 'paused', { value: true, configurable: true });
    this.dispatchEvent(new Event('pause'));
  };
  proto.load = function load() {};
  for (const [name, initial] of [['currentTime', 0], ['duration', 0], ['volume', 1]] as const) {
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: HTMLAudioElement) {
        return (this as unknown as Record<string, number>)[`_${name}`] ?? initial;
      },
      set(this: HTMLAudioElement, v: number) {
        (this as unknown as Record<string, number>)[`_${name}`] = v;
      },
    });
  }
  Object.defineProperty(proto, 'paused', { value: true, configurable: true, writable: true });
}

/** Boot a fresh player against a fresh copy of the legacy document. */
export function mountLegacyPlayer(respond: Responder = () => ({})): Harness {
  const html = readFileSync(LEGACY_HTML, 'utf8');
  // Body markup only. The inline script is the view layer -- it fetches on
  // load and is not what these tests are about.
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');

  localStorage.clear();
  stubMediaElement();

  const calls: string[] = [];
  window.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const payload = respond(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload)),
    } as Response);
  }) as typeof fetch;
  // sendBeacon is preferred by the play logger; route it through fetch so the
  // calls are observable in one place.
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => false });

  const created: HTMLAudioElement[] = [];
  const NativeAudio = window.Audio;
  window.Audio = function Audio(this: unknown, src?: string) {
    const el = new NativeAudio(src);
    created.push(el);
    return el;
  } as unknown as typeof window.Audio;

  // Evaluate the real file. indirect eval so it runs in global scope, which is
  // what a <script> tag would give it.
  (0, eval)(readFileSync(LEGACY_PLAYER, 'utf8'));

  const audio = document.querySelector('#audio') as HTMLAudioElement;
  const bar = document.querySelector('#player-bar') as HTMLElement;

  const playControl = (t: Track) => {
    const b = document.createElement('button');
    b.className = 'track-play';
    b.dataset.trackId = t.id;
    b.dataset.trackName = t.name;
    b.dataset.trackArtists = t.artists;
    b.dataset.trackDuration = String(t.durationMs);
    if (t.albumId) b.dataset.trackAlbum = t.albumId;
    if (t.imageUrl) b.dataset.trackImage = t.imageUrl;
    return b;
  };

  return {
    audio,
    bar,
    allAudio: () => [audio, ...created],
    append: (tracks, options) =>
      (window as unknown as { musicQueueAppend: (t: Track[], o?: unknown) => void })
        .musicQueueAppend(tracks, options),
    has: (id) =>
      (window as unknown as { musicQueueHas: (i: string) => boolean }).musicQueueHas(id),
    playFromRows: (tracks, index) => {
      // The queue is built by reading these buttons back out of the DOM -- see
      // setQueueFromButtons. Reproducing that here is the whole point: it is
      // the coupling the React version has to replace rather than port.
      const rows = document.createElement('div');
      rows.className = 'rows';
      for (const t of tracks) rows.append(playControl(t));
      (document.querySelector('#main') ?? document.body).append(rows);
      (rows.children[index] as HTMLElement).click();
    },
    click: (selector) => (document.querySelector(selector) as HTMLElement)?.click(),
    seekTo: (seconds) => {
      audio.currentTime = seconds;
      audio.dispatchEvent(new Event('timeupdate'));
    },
    storage: () => {
      const raw = localStorage.getItem('music-taste-player-v1');
      return raw ? JSON.parse(raw) : null;
    },
    calls,
  };
}
