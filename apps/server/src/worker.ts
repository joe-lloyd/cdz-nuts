// The Worker: the same web app and nightly export, in workerd.
//
// One Durable Object, `Music`, runs everything. The app's code is synchronous
// SQL over eight databases that join each other, and a Durable Object's SQLite
// is synchronous and local, so the code runs inside it unchanged against one
// database holding every table (sql-do.ts). That also leaves one writer for the
// shared databases, which two processes used to share. The Worker in front only
// forwards requests, cron ticks included, to the one object.
//
// workerd drops an idle Durable Object after about ten seconds, and the app
// keeps state in memory that is expensive to build (the Jellyfin index takes
// seventeen seconds), so the object re-arms an alarm every five seconds and
// stays loaded. The same alarm drives the app's periodic jobs (background.ts).
// A cron each minute re-arms it too, in case workerd was restarted.
import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { handleAdmin } from './admin.ts';
import type { TokenStore, TokenSet } from './auth.ts';
import { createBackground } from './background.ts';
import { diskFiles, guardFiles, type Fetcher, type Files } from './files.ts';
import { createNightly } from './nightly.ts';
import { provideRuntime } from './runtime.ts';
import { durableObjectSql } from './sql-do.ts';
import { makeUi, type UiManifest } from './ui.ts';

type Env = {
  APP: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response>; cron(expression: string): Promise<void> } };
  /** eliot's music library, read-only, and the folder of cover images. */
  LIBRARY: Fetcher;
  IMAGES: Fetcher;
  /** The Worker's own files folder, for what must survive and stay out of the backup. */
  STATE: Fetcher;
  /** packages/ui: routes.json's folder, holding public/. */
  ASSETS: Fetcher;
  UI_ROUTES: UiManifest;
  ADMIN_TOKEN?: string;
  TZ?: string;
  [name: string]: unknown;
};

/** A TCP connect that gives up quickly, from workerd's own socket API. */
async function probe(host: string, port: number): Promise<boolean> {
  const socket = connect({ hostname: host, port });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 1_500); }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    socket.close().catch(() => {});
  }
}

const TOKENS_FILE = 'http://disk/spotify-tokens.json';

function diskTokenStore(state: Fetcher): TokenStore {
  return {
    async load() {
      const response = await state.fetch(TOKENS_FILE);
      if (!response.ok) { await response.body?.cancel(); return null; }
      return await response.json() as TokenSet;
    },
    async save(tokens) {
      const response = await state.fetch(TOKENS_FILE, { method: 'PUT', body: JSON.stringify(tokens) });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`could not save the Spotify tokens (${response.status})`);
    },
  };
}

const ALARM_EVERY_MS = 5_000;

export class Music extends DurableObject<Env> {
  #ready: Promise<void>;
  #handle!: (request: Request) => Promise<Response>;
  #background!: ReturnType<typeof createBackground>;
  #nightly!: ReturnType<typeof createNightly>;
  #sql = durableObjectSql(this.ctx.storage);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ready = ctx.blockConcurrencyWhile(async () => {
      // The app reads its settings from process.env, as it does in Node.
      for (const [name, value] of Object.entries(env)) if (typeof value === 'string') process.env[name] = value;

      const library = process.env.APP_LIBRARY_PREFIX ?? '/music';
      const imagesDir = process.env.IMAGES_DIR ?? '/images';
      const raw = diskFiles([{ prefix: library, disk: env.LIBRARY }, { prefix: imagesDir, disk: env.IMAGES }]);
      const sourceHost = process.env.MUSIC_SOURCE_HOST ?? '';
      const files: Files = sourceHost
        ? guardFiles(raw, library, () => probe(sourceHost, Number(process.env.MUSIC_SOURCE_PORT ?? 2049)))
        : raw;
      const ui = makeUi(env.UI_ROUTES, async (file) => {
        const response = await env.ASSETS.fetch(`http://assets/${file}`);
        if (!response.ok) { await response.body?.cancel(); return null; }
        return new Uint8Array(await response.arrayBuffer());
      });
      provideRuntime({ sql: this.#sql, files, ui, probe });

      // The tables every other part of the app expects to find, before the first query.
      const { TasteDb } = await import('./db.ts');
      const { AlbumGroupStore } = await import('./album-groups.ts');
      const databaseFile = process.env.SPOTIFY_DB ?? 'spotify';
      new TasteDb(databaseFile);
      new AlbumGroupStore(databaseFile);

      const app = await import('./app.ts');
      app.init();
      this.#handle = app.handle;
      this.#background = createBackground(app.backgroundJobs(), Date.now());
      this.#nightly = createNightly({
        files, imagesDir, databaseFile,
        tokens: diskTokenStore(env.STATE),
        clientId: () => process.env.SPOTIFY_CLIENT_ID ?? '',
      });
      this.#background.tick(Date.now());
      await ctx.storage.setAlarm(Date.now() + ALARM_EVERY_MS);
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ready;
    const admin = await handleAdmin(request, {
      sql: this.#sql.open('admin'),
      token: this.env.ADMIN_TOKEN ?? '',
      state: this.env.STATE,
      nightly: this.#nightly,
    });
    return admin ?? this.#handle(request);
  }

  async alarm(): Promise<void> {
    await this.#ready;
    this.#background.tick(Date.now());
    await this.ctx.storage.setAlarm(Date.now() + ALARM_EVERY_MS);
  }

  /** Called by the Worker's scheduled(): a cron expression from worker.json. */
  async cron(expression: string): Promise<void> {
    await this.#ready;
    // Every minute: nothing to do but be awake, which the constructor and alarm already saw to.
    if (expression === '* * * * *') return;
    // 04:00 where the house is. The two crons cover summer and winter time; only the one that is 04:00 runs.
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: this.env.TZ || 'UTC', hour: '2-digit', hourCycle: 'h23' }).format(new Date());
    if (hour === '04') this.#nightly.start();
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.APP.get(env.APP.idFromName('music')).fetch(request);
  },
  async scheduled(controller: { cron: string }, env: Env): Promise<void> {
    await env.APP.get(env.APP.idFromName('music')).cron(controller.cron);
  },
};
