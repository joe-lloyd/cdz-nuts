// Give the files Lidarr never touched a recording and a release. Runs after
// the daily export, or by hand:
//
//   node src/identify-files.ts                             # every pending file
//   node src/identify-files.ts --artist "Porcupine Tree" --dry-run --show
//   node src/identify-files.ts --limit 50
//   node src/identify-files.ts --audit --dry-run     # ask the model even where a rule decides, to compare
//
// One MusicBrainz search a second, so a first run over a few hundred files
// takes minutes; after that only new files are searched. --dry-run writes
// nothing; --show prints every verdict with the candidates it chose among.

import path from 'node:path';
import { parseArgs } from 'node:util';

import { FileIdentityStore, emptyRun, identifyFiles, type FileVerdict, type Judged } from './file-identity.ts';
import { PROVENANCE_FILE } from './provenance.ts';
import { TypeSafe } from './typesafe.ts';

export async function identifyPending(options: { artist?: string; limit?: number; write?: boolean; audit?: boolean; show?: boolean; log?: (line: string) => void } = {}) {
  const log = options.log ?? console.log;
  const store = new FileIdentityStore(PROVENANCE_FILE);
  const client = TypeSafe.fromEnv();
  if (!client) log('TypeSafe key not set (TYPESAFE_API_KEY_FILE or TYPESAFE_API_KEY): files will be searched but not judged.');
  const run = emptyRun();
  try {
    let files = store.pending(options.artist);
    if (options.limit) files = files.slice(0, options.limit);
    log(`${files.length} file(s) to identify`);
    await identifyFiles(store, files, client, run, {
      write: options.write,
      audit: options.audit,
      log,
      onVerdict: options.show ? (v: FileVerdict, item: Judged) => {
        const name = item.file.path.slice(item.file.path.lastIndexOf('/') + 1);
        const seconds = (ms: number | null) => (ms == null ? '?' : Math.round(ms / 1000));
        log(`\n${name}  [${item.file.album ?? ''}] ${seconds(item.file.duration_ms)} s`);
        item.candidates.forEach((c, j) => {
          const mark = `c${j}` === v.choice ? '>' : ' ';
          log(`  ${mark} c${j} ${c.title}${c.disambiguation ? ` (${c.disambiguation})` : ''} ${seconds(c.lengthMs)} s  on ${c.releases.slice(0, 3).map((r) => `${r.title}${r.type ? ` [${r.type}]` : ''}`).join(' | ')}`);
        });
        log(`  => ${v.choice} p=${v.p.toFixed(2)} conf=${v.confidence.toFixed(2)}${v.release_title ? `  release: ${v.release_title}` : ''}${v.choice !== 'none' && !v.recording_mbid ? '  (below threshold)' : ''}`);
      } : undefined,
    });
  } finally {
    store.close();
  }
  return run;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const { values } = parseArgs({
    options: {
      artist: { type: 'string' },
      limit: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      audit: { type: 'boolean', default: false },
      show: { type: 'boolean', default: false },
    },
  });
  const run = await identifyPending({
    artist: values.artist, limit: values.limit ? Number(values.limit) : undefined, write: !values['dry-run'], audit: values.audit, show: values.show,
  });
  console.log('\nfile identification:');
  for (const [key, value] of Object.entries(run)) {
    if (key === 'errors') { if ((value as string[]).length) console.log(`  errors: ${(value as string[]).length}`); continue; }
    console.log(`  ${key}: ${value}`);
  }
}
