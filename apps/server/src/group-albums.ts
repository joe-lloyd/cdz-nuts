// Group the albums table into records. Runs after the daily export, or by
// hand:
//
//   node src/group-albums.ts                      # the whole library
//   node src/group-albums.ts --artist "Porcupine Tree" --dry-run --show
//
// --dry-run computes and prints but writes nothing, not even verdicts.
// --show prints every pair verdict and the resulting groups.
// Without a TypeSafe key only the code rules run, which is still worth doing:
// it collapses the exact duplicates and the marked editions.

import path from 'node:path';
import { parseArgs } from 'node:util';

import { AlbumGroupStore, emptyRun, groupArtist, type GroupMember, type PairVerdict } from './album-groups.ts';
import { TypeSafe } from './typesafe.ts';

const DB_FILE = process.env.SPOTIFY_DB ?? path.join(import.meta.dirname, '..', 'data', 'spotify.db');

export async function groupAlbums(options: { artist?: string; write?: boolean; show?: boolean; log?: (line: string) => void } = {}) {
  const log = options.log ?? console.log;
  const store = new AlbumGroupStore(DB_FILE);
  const client = TypeSafe.fromEnv();
  if (!client) log('TypeSafe key not set (TYPESAFE_API_KEY_FILE or TYPESAFE_API_KEY): rules only, nothing will be asked.');
  const run = emptyRun();
  const shown: { artist: string; members: GroupMember[]; verdicts: PairVerdict[]; names: Map<string, string> }[] = [];
  try {
    const artists = store.artists(options.artist);
    for (const artist of artists) {
      const { members, verdicts } = await groupArtist(store, artist, client, run, { write: options.write, log });
      if (options.show && (members.length || verdicts.length)) {
        shown.push({ artist: artist.name, members, verdicts, names: new Map(artist.albums.map((a) => [a.id, `${a.name} (${(a.release_date ?? '').slice(0, 4)}, ${a.total_tracks} tr)`])) });
      }
    }
  } finally {
    store.close();
  }
  for (const { artist, members, verdicts, names } of shown) {
    log(`\n== ${artist}`);
    for (const v of verdicts) {
      const p = Math.max(v.p_same_release, v.p_edition, v.p_different);
      log(`  ${v.choice.padEnd(12)} p=${p.toFixed(2)} conf=${v.confidence.toFixed(2)}  ${names.get(v.a)}  ~  ${names.get(v.b)}`);
    }
    const groups = new Map<string, GroupMember[]>();
    for (const m of members) groups.set(m.group_id, [...(groups.get(m.group_id) ?? []), m]);
    for (const [canonical, rows] of groups) {
      log(`  [${names.get(canonical)}]`);
      for (const m of rows) if (m.relation !== 'canonical') log(`     ${m.relation.padEnd(12)} via ${m.source}${m.p != null ? ` p=${m.p.toFixed(2)}` : ''}  ${names.get(m.album_id)}`);
    }
  }
  return run;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const { values } = parseArgs({
    options: {
      artist: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      show: { type: 'boolean', default: false },
    },
  });
  const run = await groupAlbums({ artist: values.artist, write: !values['dry-run'], show: values.show });
  console.log('\nalbum grouping:');
  for (const [key, value] of Object.entries(run)) {
    if (key === 'errors') { if ((value as string[]).length) console.log(`  errors: ${(value as string[]).length}`); continue; }
    console.log(`  ${key}: ${value}`);
  }
}
