// The SQL the app uses, as an interface, so the same store code runs on
// node:sqlite (local development, the tests) and on a Durable Object's SQLite
// (the Worker on workerd). The surface is the part of node:sqlite the stores
// actually call: exec, prepare().all/get/run, and one transaction helper
// instead of hand-written BEGIN and COMMIT, which a Durable Object refuses.
//
// Each runtime provides a SqlHost once, before anything opens a database. A
// store asks for a database by file name. node:sqlite opens that file. A
// Durable Object has one database for the whole object, so it hands every name
// the same connection; the table names are unique across the old files, which
// is what makes that safe (sql.test.ts checks it).

export type SqlParam = string | number | bigint | boolean | null | undefined;
export type Row = Record<string, unknown>;
export type RunResult = { changes: number; lastInsertRowid: number };

export interface Statement {
  all(...params: SqlParam[]): Row[];
  get(...params: SqlParam[]): Row | undefined;
  run(...params: SqlParam[]): RunResult;
}

export interface Sql {
  /** One or more statements, no parameters. */
  exec(sql: string): void;
  prepare(sql: string): Statement;
  /** True while a transaction is open, so a read can tell it may still be rolled back. */
  readonly inTransaction: boolean;
  /** Runs `fn` atomically: every write inside it commits together, or none does if it throws. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export type OpenOptions = {
  /**
   * Other database files whose tables this connection can name without a
   * prefix, by schema name. A host with one database for everything has
   * nothing to attach: the tables are already there.
   */
  attach?: Record<string, string>;
};

export interface SqlHost {
  /** `:memory:` is a private, empty database on a host that has files. */
  open(file: string, options?: OpenOptions): Sql;
}

/** What a binding means to SQLite: booleans are integers, undefined is NULL, bigints are numbers. */
export function sqlParam(value: SqlParam): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  return value;
}

let host: SqlHost | null = null;

/** Called once by the entry point of each runtime, before any store is built. */
export function provideSql(next: SqlHost): void {
  host = next;
}

export function openSql(file: string, options?: OpenOptions): Sql {
  if (!host) throw new Error('no SQL host: the entry point must call provideSql() first');
  return host.open(file, options);
}
