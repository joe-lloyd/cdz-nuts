# Search

## Sub-features

Songs, artists, albums, playlists, empty results, request failure, changing query, and Discogs: search beyond the library, tracklists, discographies, add to library.

## How to get to it (user POV)

Type into Search music from any panel.

## Driving it with Playwright

Run pnpm verify:search from apps/server. Assert grouped results and navigate an artist or playlist link.
Run pnpm verify:discogs for the Discogs section. It serves a fictional band from src/fake-discogs.ts, so no token is needed; search "Quiet Ferns", "ratelimit" or "outage".

## Gotchas

Two-character minimum. Search covers synced metadata and local files, not the live Spotify catalog.
Discogs is asked only when Search Discogs is pressed, and adding writes metadata only.
