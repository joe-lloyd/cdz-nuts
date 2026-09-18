# packages/ui

The front end of the home music player, kept as one package so that **the web
app and the desktop app serve the same bytes**.

Two things consume it:

| Consumer | What it is | How it mounts this |
|---|---|---|
| `apps/server` | the Node server on pi-server, behind `https://music.home.arpa` | imports `index.js` by relative path and serves `public/` |
| `apps/desktop` | the Tauri desktop tray app | `include_dir!` over `public/` at compile time, served from a custom URI scheme |

Before this existed there was one copy, in the server's `public/`. A desktop
app would have meant a second copy, and a second copy means the two drift: you
fix a lyric-scroll bug in one and forget the other.

## Layout

```
src/                  React 19 + TypeScript source, built by Vite
static/               hand-written files copied verbatim into the build
public/               the BUILD OUTPUT, committed on purpose (see below)
  index.html          the single-page document
  app.css             all of the styling
  app.js              the bundle
  icon.svg            app and tray icon
  manifest.webmanifest
  sw.js
routes.json           what serves at which URL, with which content type
index.js              Node helper that resolves routes.json to absolute paths
```

Note the naming inversion against Vite's defaults: `static/` is Vite's
`publicDir` and `public/` is its `outDir`. `vite.config.ts` says why.

## `public/` is build output and it is committed

Neither consumer runs a JS toolchain. The server runs straight off a bind mount
on the Pi with no install step, and cargo does not run Vite. So the bundle is
committed, with fixed unhashed filenames so `routes.json` stays stable, and CI
rebuilds it and fails if the committed copy does not match `src/`.

That means every change to `src/` ends with:

```sh
pnpm build      # from the repository root
git add packages/ui/public
```

## `routes.json` is the contract

Routing lives in a JSON file rather than in `index.js` because **one of the
two consumers is not JavaScript.** The Rust shell reads this manifest
directly. Had the map lived in Node, the desktop side would have had to restate
it, which is exactly the drift this package exists to prevent.

Node consumers get it resolved for them:

```js
import { indexHtml, staticFiles, documentUrls } from '../../../packages/ui/index.js';

// staticFiles === { '/app.css': { file: '<abs>', type: 'text/css; charset=utf-8', ... }, ... }
```

## The API lives in `apps/server`, not here

This package is presentation only. Every request the player makes is
**root-relative**: `/api/player/resolve`, `/api/player/stream`,
`/api/player/lyrics`. So it resolves against whatever origin served the page.

That is the hinge the desktop app turns on: point the origin at a local handler
and the same untouched bundle talks to home through a WireGuard tunnel, with
no idea anything changed. Do not introduce absolute URLs here.

## Tests

```sh
pnpm test:unit       # vitest, component and player engine tests
pnpm test:contract   # node --test: routes.json and public/ still agree
```

## Changing the UI

Edit `src/`, run `pnpm build`, commit source and `public/` together. The
server picks it up on its next `git pull`; the desktop picks it up on its next
release, and reports itself stale until then through `/api/ui-build`.
