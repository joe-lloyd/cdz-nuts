# Handoff: album identity and file matching

Received 2026-09-18 and copied as written. It predates the move into this
repository: `music-dump` is now `apps/server` in `cdz-nuts`, so every `src/`
path below is relative to `apps/server/`, and the pi-server checkout will be
`~/cdz-nuts` once the cutover in the root README's plan has happened. Until
then the paths and hosts below are still literally true.

---

## Handoff: album identity and file matching in music-dump

**Repo:** `github.com/joe-lloyd/music-dump` (local `~/Projects/MyProjects/music-dump`, Forgejo mirror `git.home.arpa/joe-lloyd/music-dump`). Deployed on pi-server as `spotify-taste-db` / `spotify-taste-db-web`, source bind-mounted from `~/spotify-taste-db`, data in `~/spotify-taste-db/data/` (`spotify.db`, `provenance.db`). Copy the DBs with `scp pi-server:spotify-taste-db/data/{spotify,provenance}.db .` to work locally.

**Tickets:** [SPOT-25](https://plane.home.arpa/homelab/projects/337793e2-25c7-4d78-9d0a-01d3e00bac4e/issues/425f18dd-de1f-426a-b4d3-a706d85fa920) (urgent, wrong take plays), [SPOT-19](https://plane.home.arpa/homelab/projects/337793e2-25c7-4d78-9d0a-01d3e00bac4e/issues/fece32c9-0713-4868-b831-5d468d256ffd) (files belong to real releases). The duplicate album cards have no ticket yet; file one under SPOT.

### The two root causes

1. Album identity is a Spotify id. `/api/artist` in `src/server.ts` (~line 1655) selects every `albums` row joined to the artist, and Spotify lists one record several times. Live DB: 15,002 album rows, 263 exact duplicate groups (same artist, name, year), 439 names carrying Remaster/Deluxe/Edition. Porcupine Tree alone has "Recordings" twice, "Lightbulb Sun" twice, "Deadwing" beside "Deadwing (Remastered)".
2. Track identity is a normalised artist+title string. `byMatchKey(key, album?)` in `src/provenance.ts:627` falls back to the biggest file when nothing carries the album tag. 585 files share a key with another file (274 groups). 390 files sit in `_Singles/<Artist>/` folders and get a fake album from `libAlbumId()` (folder hash).

### Do in this order

**1. SPOT-25, pure code, no AI.** The ticket is spec-complete: a shared `DURATION_TOLERANCE_MS = 5000`, `byMatchKey` takes the track length and returns null when no file is within tolerance (fall through to today's behaviour only when the length is unknown), `scoreJellyfinMatch` in `src/jellyfin.ts:124` fails below threshold outside the tolerance. Tests in `provenance.test.ts` and `jellyfin.test.ts` asserting the returned path. Call sites to update are listed in the ticket. Verify on the *Recordings* and *Stupid Dream* pages against the real library.

**2. Album grouping (fixes the duplicate cards).** New table `album_group(album_id PK, group_id, relation)` where `relation` is `same_release | edition`. Built by a job after the discography sync:
- Code: rows with equal (artist, normalised name, release year) → one group.
- TypeSafe: within one artist, pairs whose names share a first word → one Choice question, criteria `same_release | edition | different`. Prototype over Porcupine Tree's 31 rows got 11/11 right (live album ≠ studio, remaster = edition, region duplicate = same release), ~500 input tokens a pair. Accept at ≥ 0.8; below that leave ungrouped.
- Artist page: one card per group, `is_saved` if any member is saved, canonical id = earliest plain release. Album page lists the other editions. Prefer grouping in the query layer so nothing is deleted.

**3. SPOT-19, file → real release.** For each file in a `_Singles` folder or a match_key collision group: MusicBrainz recording search by artist + title (rate limit 1/s, see `src/musicbrainz.ts`), candidates with lengths and their releases; one TypeSafe request with a Choice over candidates plus `none`: "which recording is this file", judged on title, duration, album tag, track number. Accept ≥ 0.8. Store `file_release(path, recording_mbid, release_mbid, release_group_mbid, p)`. Then `byMatchKey` can prefer recording identity over the name key, and `_Singles` stops rendering as an album. `pickAlbumGroup` in `src/albumref.ts:155` is the existing hand-written scorer for this decision; keep it as the fallback when the judge is unavailable. The same pattern is already running in `HomeLab/eliot/acquisition/import-rescue.py` (release choice, then per-file track choice) if you want a worked example.

### TypeSafe in one paragraph

`POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer <key>`, body `{"state": <json>, "model": "jev-latest", "questions": {...}}`. Question types: `choice` (criteria = map of option → description, answer has `choice` and `probabilities`), `noul` (yes/no probability), `score` (ordered levels). It selects and scores; it never writes text, so every candidate must be in the criteria and there must be a `none` option. Docs: `https://docs.typesafe.ai/llms.txt`. Key on the Mac at `~/.secrets/typesafe-api-key`; on pi-server put it at `/etc/homelab/spotify-taste-db/typesafe-api-key` and mount it like the ntfy token in `docker-compose.yml`. Free tier today; it has been pasted in chat, rotate when that ends. Keep thresholds in code, keep the raw probabilities in the table, and cache verdicts so a nightly job doesn't re-ask.

### Gotchas

- `albums.total_tracks` and `release_date` come from Spotify and are reliable enough to prefilter on; `label` is null until hydrated.
- `provenance.db` is written by the scanner with WAL; copy the `-wal` file too or checkpoint first.
- Do not touch the folder-hash ids (`libalbum-`, `libtrack-`); the client router and existing URLs depend on them. Add identity beside them.
- HomeLab is mid-refactor into a fleet repo (HOME-119 series); music-dump is already its own repo, so nothing here is affected.
