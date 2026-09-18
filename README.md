# cdz-nuts

The home music player, in one repository with three outcomes:

| Directory | What it is | How it ships |
|---|---|---|
| [`apps/server`](apps/server) | The Spotify exporter and the Node web server behind `https://music.home.arpa` | `git pull` on pi-server, bind-mounted into `node:24-alpine` |
| [`packages/ui`](packages/ui) | The React front end, one copy served by both apps | Built with Vite, and the output in `public/` is committed |
| [`apps/desktop`](apps/desktop) | The Tauri tray app with its own WireGuard tunnel, macOS, Windows and Linux | Tag `desktop-v*`, GitHub Actions builds, signs and publishes; installed copies self-update |

These used to be three repositories, with the front end vendored into the other
two as a git submodule and a bot opening pull requests to move the pointer.
The pointers were stale more often than not. Now a change to the front end
lands in the same commit as the server or desktop change that needs it.

## Working on it

Node 24 or newer and pnpm. Rust for the desktop app only.

```sh
pnpm install          # one lockfile, all JavaScript packages
pnpm typecheck        # packages/ui
pnpm test             # packages/ui and apps/server
pnpm build            # rebuilds packages/ui/public; commit the result
```

Each directory's README covers its own setup, deployment and design.

## The one rule

`packages/ui/public` is build output and it is committed, because neither
consumer runs a JavaScript toolchain: the server runs off a bind mount with no
install step, and cargo embeds the directory as it is. After any change to
`packages/ui/src`, run `pnpm build` and commit `public/` with it. CI rebuilds
and fails the pull request if the two disagree.

The desktop app embeds that directory at compile time, so it ships a snapshot.
The server serves it from disk. `GET /api/ui-build` on the server and the
desktop's own `uicheck` compare hashes of the two so a stale desktop says so.
