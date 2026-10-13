// The exporter from the command line (pnpm export). The Worker runs the same
// export, and the album grouping and file identification after it, from a cron.
import './load-env.ts';
import './sql-node-host.ts';
import path from 'node:path';
import { configureNodeAuth } from './auth-node.ts';
import { TasteDb } from './db.ts';
import { runExport } from './exporter.ts';
import { nodeFiles } from './files-node.ts';

const DB_FILE = process.env.SPOTIFY_DB ?? path.join(import.meta.dirname, '..', 'data', 'spotify.db');

configureNodeAuth();
runExport(new TasteDb(DB_FILE), {
  files: nodeFiles,
  imagesDir: path.join(path.dirname(DB_FILE), 'images'),
  label: DB_FILE,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
