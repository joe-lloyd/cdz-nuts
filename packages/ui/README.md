# music-ui

The front end of the home music player, extracted so that **the web app and the
desktop app serve the same bytes**.

Two things consume this package:

| Consumer | What it is | How it mounts this |
|---|---|---|
| [`music-dump`](https://github.com/joe-lloyd/music-dump) | the Node server on pi-server, behind `https://music.home.arpa` | submodule at `ui/`, read by `src/server.ts` |
| [`homelab-music`](https://github.com/joe-lloyd/homelab-music) | the Tauri desktop tray app | submodule at `ui/`, served from a custom URI scheme |

Before this existed there was one copy, in `music-dump/public/`. A desktop app
would have meant a second copy, and a second copy means the two drift — you fix
a lyric-scroll bug in one and forget the other. Now there is one copy and both
sides pin it by commit.

## There is no build step

These are the files the browser receives, byte for byte. No bundler, no
transpiler, no framework. `player.js` is plain ES modules against the DOM,
`app.css` is hand-written, `index.html` is the whole single-page document.

That is a deliberate property, not an accident waiting to be fixed. It is what
makes the desktop shell able to serve the identical file off disk without
running Node at all.

## Layout

```
public/
  index.html            the single-page document
  app.css               all of the styling
  player.js             queue, gapless prefetch, seek, Media Session, lyrics
  icon.svg              app + tray icon
  manifest.webmanifest  makes the web app installable
  sw.js                 minimal service worker (install-ability; passthrough)
routes.json             what serves at which URL, with which content type
index.js                Node helper that resolves routes.json to absolute paths
```

## `routes.json` is the contract

The reason routing lives in a JSON file rather than in `index.js` is that **one
of the two consumers is not JavaScript.** The Rust shell reads this manifest
directly. Had the map lived in Node, the desktop side would have had to restate
it, which is exactly the drift this package exists to prevent.

Node consumers get it resolved for them:

```js
import { indexHtml, staticFiles, documentUrls } from '@joe-lloyd/music-ui';

// staticFiles === { '/app.css': { file: '<abs>', type: 'text/css; charset=utf-8', ... }, ... }
```

## The API lives in `music-dump`, not here

This package is presentation only. Every request `player.js` makes is
**root-relative** — `/api/player/resolve`, `/api/player/stream`,
`/api/player/lyrics` — so it resolves against whatever origin served the page.

That is the hinge the desktop app turns on: point the origin at a local handler
and the same untouched `player.js` talks to home through a WireGuard tunnel,
with no idea anything changed. Do not introduce absolute URLs here.

## Tests

```sh
node --test test/*.test.js
```

Five assertions, all guarding the same thing: that `routes.json` and `public/`
still agree. A rename that updates only one side fails here.

## Changing the UI

Edit it here, commit, then bump the submodule pointer in whichever consumers
should get it — they are pinned by commit, so a change is not live until you
say so on each side. Update both, or knowingly update one.
