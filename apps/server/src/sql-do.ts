// A Durable Object's SQLite as a SqlHost. A Durable Object has one database, so
// every name a store asks for gets the same connection. That is safe because no
// two of the old database files share a table name (sql-do.test.ts checks it).
//
// Three things differ from node:sqlite and are handled here, not in the stores:
// BEGIN and COMMIT are refused (transactionSync runs the function atomically
// instead), the file-tuning pragmas journal_mode and busy_timeout are refused
// (they mean nothing to a storage engine the runtime owns, so they are dropped),
// and a statement does not report its changes or its new row id (SQLite's own
// changes() and last_insert_rowid() are asked for, on the same connection).
import { sqlParam, type Row, type Sql, type SqlHost, type SqlParam, type Statement } from './sql.ts';

/** The part of Durable Object storage this file uses. */
export interface DurableObjectStorage {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } };
  transactionSync<T>(fn: () => T): T;
}

const TUNING_PRAGMA = /^[ \t]*PRAGMA[ \t]+(journal_mode|busy_timeout)\b[^;]*;?[ \t]*$/gim;

class DurableObjectSql implements Sql {
  readonly #storage: DurableObjectStorage;
  #depth = 0;
  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }
  #rows(sql: string, params: SqlParam[] = []): Row[] {
    return this.#storage.sql.exec(sql, ...params.map(sqlParam)).toArray() as Row[];
  }
  exec(sql: string): void {
    const script = sql.replace(TUNING_PRAGMA, '');
    if (script.trim()) this.#rows(script);
  }
  prepare(sql: string): Statement {
    return {
      all: (...params) => this.#rows(sql, params),
      get: (...params) => this.#rows(sql, params)[0],
      run: (...params) => {
        this.#rows(sql, params);
        const { changes, id } = this.#rows('SELECT changes() AS changes, last_insert_rowid() AS id')[0] as { changes: number; id: number };
        return { changes, lastInsertRowid: id };
      },
    };
  }
  get inTransaction(): boolean {
    return this.#depth > 0;
  }
  transaction<T>(fn: () => T): T {
    return this.#storage.transactionSync(() => {
      this.#depth += 1;
      try {
        return fn();
      } finally {
        this.#depth -= 1;
      }
    });
  }
  close(): void {
    // The connection belongs to the object, and every store shares it.
  }
}

export function durableObjectSql(storage: DurableObjectStorage): SqlHost {
  const sql = new DurableObjectSql(storage);
  return { open: () => sql };
}
