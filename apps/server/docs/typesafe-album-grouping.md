# TypeSafe on album grouping: what it did, measured

The first production use of TypeSafe in this repository, 2026-09-18. The job
is `src/group-albums.ts`; the judgement is in `src/album-groups.ts`; the
client is `src/typesafe.ts`. Every number below comes from
`album_pair_verdicts` and `album_group` in the live database after the first
run.

## The job

Spotify lists one record several times. The artist page showed every row, so
Porcupine Tree had Recordings twice, Lightbulb Sun twice and Deadwing beside
Deadwing (Remastered). The fix is a table saying which rows are the same
record, and the query layer folding members under one canonical row.

Two rules decide what rules can decide:

- same normalised title, same year: `same_release`
- titles that differ only by an edition marker such as "(Remastered)",
  "(Deluxe Edition)", "[Bonus Edition]": `edition`

What is left is judgement. Same-type album pairs that share a first word and
that no rule settled go to TypeSafe as one Choice question each, with three
options: `same_release`, `edition`, `different`. A verdict is acted on at
p ≥ 0.8. Every verdict is stored with its full distribution, so the nightly
run asks only about pairs it has never seen, and the threshold can be
changed without asking again.

Singles never reach the model. A remix single shares its first word with the
original and every other remix, and each is a different recording, so those
pairs would have been most of the volume for a certain "different".

## What it cost

| | |
|---|---|
| Artists with two or more albums | 1,372 |
| Album rows considered | 18,454 |
| Pairs settled by a rule | 732 |
| Pairs sent to the model | 2,222 (2,034 distinct; some albums have two artists) |
| Requests | 210, batched per artist, at most 40 pairs each |
| Input tokens | 641k, about 290 per pair including the shared state |
| Output tokens | 83k |
| Model time | 57 s in total, about 280 ms a request |
| Wall time for the whole library | under three minutes, sequential |

At the free tier this cost nothing. The verdict cache means the second run
asked 6 pairs, for 3.4k tokens.

## What it decided

| Verdict | Count | Mean confidence |
|---|---|---|
| different | 1,940 | 0.97 |
| edition | 93 | 0.64 |
| same_release | 1 | 0.73 |

Probability behind the chosen option:

| edition, p | pairs | | different, p | pairs |
|---|---|---|---|---|
| ≥ 0.90 | 29 | | ≥ 0.95 | 1,807 |
| 0.80 to 0.89 | 17 | | 0.80 to 0.94 | 56 |
| 0.70 to 0.79 | 10 | | 0.60 to 0.79 | 48 |
| 0.60 to 0.69 | 11 | | < 0.60 | 29 |
| 0.50 to 0.59 | 26 | | | |

Result on the library: 443 groups, 916 rows, 477 cards folded away. The
rules account for 434 of the folded rows, the model for 43. Porcupine Tree
went from 31 cards to 25.

## Where it was right

Everything it called an edition at p ≥ 0.9 reads correct: "The End Is Begun"
and its Special Edition, "Helter Skelter" and "Helter Skelter: The Deluxe
Edition" (the colon form the marker rule misses), "OK Computer" and
"OKNOTOK 1997 2017", "Catch Thirty Three" and its 20th Anniversary Edition,
"You Fail Me" and "You Fail Me Redux", "Wish You Were Here" and "Wish You
Were Here 50", "Delicate Sound of Thunder (Live)" and its 2019 remix.

The rejections it was surest about are the ones a person would reject:
sequels ("Spindash" vs "Spindash 2": 1,431 of 1,438 pairs with a numeral
suffix are `different`), live albums against studio albums (72 of 72,
mean p 0.99), "The Marshall Mathers LP" against "LP2", soundtracks against
albums, "Run The Jewels 2" against "Run The Jewels (Deluxe European
Edition)".

Porcupine Tree's one judgement call, "CLOSURE / CONTINUATION" against
"CLOSURE / CONTINUATION. LIVE. AMSTERDAM 07/11/22", came back `different`
at p = 1.00.

## Where it hesitated, and why that is the useful part

The 0.50 to 0.60 band is almost entirely instrumental versions:
"Heritage (Instrumental)", "ERRA (Instrumental)", "Gold (Instrumental)".
Across 113 pairs with "instrumental" in a title the model split 26 edition
to 87 different with a mean p of 0.74. That is the model saying the
question is genuinely two-sided: an instrumental release is the same album
and not the same recordings. The 0.8 threshold keeps them apart without
anyone writing an "instrumental" rule, and if the product decision goes the
other way, the verdicts are already stored and a threshold change is a
query, not a rerun.

The same band holds commentary editions, "(Slowed + Reverb)" versions and
radio-edit collections, all of which are the same ambiguity.

## Where it was wrong, or arguable

Of the 46 accepted editions I dispute two: "Mutant Remixed & Remastered"
against "Mutant, Vol. 2" (0.91; the remaster is of the first Mutant), and
"ZEROBOY (Slowed + Reverb)" against "ZEROBOY" (0.80, on the line; a slowed
version is arguably a different record). Both fold one extra row under a
card and are recoverable from the album page, which names every listing.

Of the rejections, "Chilltendo" against "Chilltendo Deluxe" (different at
0.70) looks like a miss, and it is inconsistent with "Chilltendo 2" against
"Chilltendo Deluxe" being accepted as an edition at 0.86. Pairs are judged
independently, so nothing forces transitivity; union-find applies whatever
edges cross the threshold.

Confidence is reported per answer and was well behaved: high on the easy
calls, low on the two-sided ones, with no case of a confidently wrong
answer among the accepted set beyond the two above.

## What this says about the tool

- **Good at:** bounded selection over a small typed state where the options
  are well described and a "none of these" exists. It read release dates and
  track counts as evidence without being told how to weigh them, and its
  probabilities tracked how contestable the pair was.
- **Cheap enough to run over everything:** 2,222 judgements for the price
  of a few pages of text, and each result reusable for ever.
- **Not for:** anything a rule can state. The rules here did 90 percent of
  the folding at zero cost and zero ambiguity; the model earned its place on
  the remaining 10 percent, which is where the rules would have been wrong
  or unwritable ("Helter Skelter: The Deluxe Edition", "OKNOTOK").
- **Design that mattered:** one request per artist with the state shared
  across questions, an explicit `different` option, criteria that describe
  the contrast rather than the label, and storing the distribution rather
  than the choice.

## Reproduce

```sh
# any artist, no writes, every verdict and group printed
node src/group-albums.ts --artist "Porcupine Tree" --dry-run --show

# the whole library, writing album_group and caching verdicts
TYPESAFE_API_KEY_FILE=~/.secrets/typesafe-api-key node src/group-albums.ts
```

Then the two queries this report is built from:

```sql
SELECT choice, COUNT(*), AVG(confidence) FROM album_pair_verdicts GROUP BY choice;
SELECT source, COUNT(*) FROM album_group WHERE relation != 'canonical' GROUP BY source;
```
