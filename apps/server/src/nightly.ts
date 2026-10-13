// The nightly run, as the compose loop used to do it: the Spotify export, then
// the album grouping, then the file identification. Each stage logs and keeps
// going where the old loop would have: a failed export does not stop grouping
// what is already in the database.
import { configureAuth, type TokenStore } from './auth.ts';
import { groupAlbums } from './group-albums.ts';
import { identifyPending } from './identify-files.ts';
import { TasteDb } from './db.ts';
import { runExport } from './exporter.ts';
import type { Files } from './files.ts';

export type Nightly = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** One line per stage that failed, from the last run. */
  errors: string[];
};

export function createNightly(host: {
  files: Files;
  imagesDir: string;
  tokens: TokenStore;
  databaseFile: string;
  clientId: () => string;
}) {
  const state: Nightly = { running: false, startedAt: null, finishedAt: null, errors: [] };
  return {
    status: (): Nightly => ({ ...state, errors: [...state.errors] }),
    /** Starts a run in the background. False when one is already running. */
    start(): boolean {
      if (state.running) return false;
      state.running = true;
      state.startedAt = new Date().toISOString();
      state.finishedAt = null;
      state.errors = [];
      void (async () => {
        const stage = async (name: string, work: () => Promise<unknown>) => {
          try {
            await work();
          } catch (err) {
            state.errors.push(`${name}: ${(err as Error).message}`);
            console.error(`nightly ${name} failed:`, (err as Error).message);
          }
        };
        await stage('export', async () => {
          configureAuth({ clientId: host.clientId(), store: host.tokens });
          await runExport(new TasteDb(host.databaseFile), { files: host.files, imagesDir: host.imagesDir, label: host.databaseFile });
        });
        await stage('album grouping', () => groupAlbums());
        await stage('file identification', () => identifyPending());
        state.running = false;
        state.finishedAt = new Date().toISOString();
        console.log(`nightly done${state.errors.length ? ` with ${state.errors.length} failed stage(s)` : ''}`);
      })();
      return true;
    },
  };
}
