# TypeSafe on file identity: what it did, measured

The second use of TypeSafe here, 2026-09-18, and a harder one than
[album grouping](typesafe-album-grouping.md). The job is
`src/identify-files.ts`; the judgement is in `src/file-identity.ts`. Numbers
come from `file_release` after the Porcupine Tree passes on a copy of the
live database; the library-wide backlog was still running on pi-server when
this was written.

## The job

Lidarr stamps every file it imports with a MusicBrainz recording id. The
files it never touched, the singles folders and the YouTube pulls, have only
their tags, so 140 Porcupine Tree singles rendered as one record with a
borrowed cover, and a track resolved by name could be another take of the
same title.

For each such file: search MusicBrainz for recordings, with the album tag in
the query first so the record the file says it is from is in the list; prune
bootleg-only recordings, recordings of a different length, and the 5.1,
Atmos and instrumental mixes a stereo rip cannot be. If exactly one
candidate remains, it is on the album the tag names and its length agrees,
that is a rule and nothing is asked. Otherwise TypeSafe gets one Choice per
file over the candidates plus `none`, with a code-computed flag per
candidate saying whether it is on the tagged album. Accepted at p ≥ 0.8.
Code then picks the release from the chosen recording's releases, the
tagged one first.

## What it cost, Porcupine Tree

| | first pass | rerun of the 26 uncertain files |
|---|---|---|
| Files | 178 | 32 |
| Settled by rule, no model call | 76 | 3 |
| Sent to the model | 51 | 26 |
| Requests, 6 files each | 9 | 5 |
| Input tokens | 51k | 22k |
| Model time | 3.4 s | 2.2 s |
| Wall time | about 40 min | about 8 min |

The wall time is MusicBrainz: one search a second, two when the tagged
search finds nothing, and a 503 with a long back-off whenever it is busy.
The model is a rounding error in that. The library-wide pass of about a
thousand files is hours for the same reason, which is why it is a nightly
job with a cache and not something a request waits on.

## What it decided, Porcupine Tree, final state

| Outcome | Files |
|---|---|
| Identified by rule | 79 |
| Identified by the model | 33 |
| Model said `none` | 3 |
| Model unsure, left unidentified | 15 |
| No usable candidate on MusicBrainz | 48 |

115 of 178 files now carry a recording and a release. The "Singles"
collection on the site went from 140 tracks to 54, and 14 release cards
appeared beside it: Octane Twisted (17), In Absentia (24), Arriving
Somewhere (8), Deadwing (Remastered) (7), and so on, each with its own art.

The 48 with no candidate are mostly the YouTube rip of the Amsterdam live
film, whose track lengths do not match the official live album within
tolerance, and a handful of early-catalogue titles MusicBrainz lists under
different names. Those are retrieval gaps, not judgement gaps.

## Where the model was right

The accepted set reads correctly to me: every "2017 Remaster" file went to
In Absentia or Deadwing (Remastered), every "2024 Remaster" to Fear of a
Blank Planet, the live files tagged Arriving Somewhere and Octane Twisted to
those albums, at p 0.84 to 1.00. The three `none` answers were right too:
"Octane Twisted - Live" and "Don't Hate Me - Live" had only other-concert
candidates and it declined at 0.98 and 0.91.

## Where it was wrong, and what fixed it

Two failure modes, both about what the model was shown rather than how it
judged.

**Look-alikes split the probability.** MusicBrainz lists a 5.1 mix, an
Atmos mix and an instrumental beside the album version at the same length.
Shown all of them for "Shallow - 2017 Remaster", the model put 0.75 on the
album version and the rest on the 5.1 mix, and 20 of 51 judged files sat
under the threshold that way. It had no evidence to separate them, and it
said so. Pruning the mixes a stereo rip cannot be, in code, moved 11 of
those 20 over 0.9 on the rerun.

**When the right answer is absent, an impostor wins.** Files tagged
"Anesthetize", the Tilburg 2008 film, have no matching recording in
MusicBrainz's search results. The model was left with same-length live
takes from Atlanta and London and picked one at p=0.94 twice, even with the
tag flag false for every candidate. A live file belongs to the concert its
tag names, so that is now a rule that overrides an accepted answer, and both
files went back to unidentified. Same-song, same-length, different-night is
exactly the case where a probability over the wrong candidates looks
confident and is not.

After both fixes I count one arguable accept out of 33, "Cheating the
Polygraph - Live at Garage Saarbrücken" filed under Fear of a Blank Planet
(it is a bonus-disc track there, so probably right), and none I would call
wrong.

## What this says about the tool

- The judgement quality was never the problem. Both errors were retrieval:
  wrong candidates, or the right one missing. Fix the state, not the prompt.
- Its uncertainty was informative on both failure modes. The 0.5 to 0.75
  band was almost entirely the look-alike problem, and the rerun proved it:
  remove the decoys and the same files clear 0.9.
- A code-computed signal beats a semantic one. `on_the_album_the_tag_names`
  as a boolean did more than any instruction about tags.
- Rules should take what they can. 79 of 115 identifications never
  touched the model; the model earned the 33 with two or more real
  candidates.
- Cost is not the constraint. 73k tokens and six seconds of model time for
  the artist; the external catalogue's rate limit is.

## Reproduce

```sh
node src/identify-files.ts --artist "Porcupine Tree" --dry-run --show
node src/identify-files.ts --audit --dry-run --limit 40   # ask the model where a rule decided, to compare
```

```sql
SELECT choice, COUNT(*), SUM(recording_mbid IS NOT NULL) FROM file_release GROUP BY choice;
```
