// Routes under /_workers/ that move the data in and out of the Durable Object
// and start the nightly run. Nothing here is part of the app: the browser and
// the machines that call the app never see them, and every one needs the admin
// token. An unauthorized caller gets a plain 404, as if the path did not exist.
//
// Import and export go one table at a time as JSON arrays, in batches the
// caller sizes, so neither side holds a whole database in memory.
import type { TokenSet } from './auth.ts';
import type { Fetcher } from './files.ts';
import type { Nightly } from './nightly.ts';
import type { Sql, SqlParam } from './sql.ts';

export interface AdminHost {
  sql: Sql;
  /** Empty means the routes are off. */
  token: string;
  /** The Worker's own files folder, where the Spotify tokens live. */
  state: Fetcher;
  nightly: { start(): boolean; status(): Nightly };
}

const TOKENS_FILE = 'http://disk/spotify-tokens.json';
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

function sameToken(supplied: string, expected: string): boolean {
  let diff = supplied.length ^ expected.length;
  for (let i = 0; i < expected.length; i += 1) diff |= (supplied.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Tables the app owns: everything but SQLite's and the runtime's own. */
function tables(sql: Sql): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const names = sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name").all();
  for (const { name } of names) {
    found.set(String(name), sql.prepare(`SELECT name FROM pragma_table_info('${String(name).replaceAll("'", "''")}') ORDER BY cid`).all().map((c) => String(c.name)));
  }
  return found;
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

type Batch = { columns: string[]; rows: SqlParam[][] };

/** The import body, checked once here so the insert can trust it. */
function parseBatch(raw: unknown, known: string[]): Batch {
  if (typeof raw !== 'object' || raw === null) throw new Error('the body must be a JSON object');
  const { columns, rows } = raw as { columns?: unknown; rows?: unknown };
  if (!Array.isArray(columns) || !columns.length || !columns.every((c) => typeof c === 'string')) throw new Error('columns must be a list of names');
  const unknown = (columns as string[]).filter((c) => !known.includes(c));
  if (unknown.length) throw new Error(`the table has no column ${unknown.join(', ')}`);
  if (!Array.isArray(rows)) throw new Error('rows must be a list');
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== columns.length) throw new Error('every row must have one value per column');
    for (const value of row) {
      if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new Error('a value must be text, a number or null');
    }
  }
  return { columns: columns as string[], rows: rows as SqlParam[][] };
}

export async function handleAdmin(request: Request, host: AdminHost): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/_workers/')) return null;
  const supplied = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!host.token || !sameToken(supplied, host.token)) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });

  const route = url.pathname.slice('/_workers/'.length).split('/');
  try {
    if (route[0] === 'status' && request.method === 'GET') {
      const counts: Record<string, number> = {};
      for (const name of tables(host.sql).keys()) {
        counts[name] = Number((host.sql.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get() as { n: number }).n);
      }
      const tokens = await host.state.fetch(TOKENS_FILE);
      await tokens.body?.cancel();
      return json(200, { tables: counts, columns: Object.fromEntries(tables(host.sql)), nightly: host.nightly.status(), spotifyTokens: tokens.ok });
    }

    if (route[0] === 'schema' && request.method === 'GET') {
      // The statements that build the app's tables and indexes, for an export into files.
      const statements = host.sql.prepare("SELECT name, tbl_name AS \"table\", sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type DESC, name").all();
      return json(200, { statements });
    }

    if (route[0] === 'import' && route[1] && request.method === 'POST') {
      const columns = tables(host.sql).get(route[1]);
      if (!columns) return json(404, { error: `no table ${route[1]}` });
      const body = await request.text();
      if (body.length > MAX_BATCH_BYTES) return json(413, { error: 'batch too large' });
      let batch: Batch;
      try {
        batch = parseBatch(JSON.parse(body), columns);
      } catch (err) {
        return json(400, { error: (err as Error).message });
      }
      const insert = host.sql.prepare(
        `INSERT OR REPLACE INTO ${quote(route[1])} (${batch.columns.map(quote).join(', ')}) VALUES (${batch.columns.map(() => '?').join(', ')})`,
      );
      // The rows come from files SQLite never checked against their foreign keys
      // (the old connections enforced them only on write), so a dump taken in
      // table order can hold children whose parent is in the next batch.
      host.sql.exec('PRAGMA foreign_keys = OFF');
      try {
        host.sql.transaction(() => {
          if (url.searchParams.get('replace') === '1') host.sql.prepare(`DELETE FROM ${quote(route[1])}`).run();
          for (const row of batch.rows) insert.run(...row);
        });
      } finally {
        host.sql.exec('PRAGMA foreign_keys = ON');
      }
      return json(200, { table: route[1], inserted: batch.rows.length });
    }

    if (route[0] === 'export' && route[1] && request.method === 'GET') {
      const columns = tables(host.sql).get(route[1]);
      if (!columns) return json(404, { error: `no table ${route[1]}` });
      const after = Number(url.searchParams.get('after') ?? 0);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 1000), 1), 5000);
      if (!Number.isFinite(after)) return json(400, { error: 'after must be a number' });
      const rows = host.sql.prepare(
        `SELECT rowid AS "__rowid", ${columns.map(quote).join(', ')} FROM ${quote(route[1])} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      ).all(after, limit);
      return json(200, {
        columns,
        rows: rows.map((row) => columns.map((c) => row[c])),
        next: rows.length === limit ? Number(rows[rows.length - 1].__rowid) : null,
      });
    }

    if (route[0] === 'spotify-tokens' && request.method === 'PUT') {
      const tokens = JSON.parse(await request.text()) as Partial<TokenSet>;
      if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string' || typeof tokens.expires_at !== 'number') {
        return json(400, { error: 'tokens need access_token, refresh_token and expires_at' });
      }
      const saved = await host.state.fetch(TOKENS_FILE, { method: 'PUT', body: JSON.stringify(tokens) });
      await saved.body?.cancel();
      return saved.ok ? json(200, { saved: true }) : json(502, { error: `the files folder answered ${saved.status}` });
    }

    if (route[0] === 'export-run' && request.method === 'POST') {
      return host.nightly.start() ? json(202, { started: true }) : json(409, { error: 'a run is already going' });
    }
  } catch (err) {
    return json(500, { error: (err as Error).message });
  }
  return json(404, { error: 'no such admin route' });
}
