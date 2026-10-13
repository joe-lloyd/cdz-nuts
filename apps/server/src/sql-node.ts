// node:sqlite as a SqlHost: one file per database name, the way the app has
// always stored its data.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqlParam, type OpenOptions, type Row, type Sql, type SqlHost, type SqlParam, type Statement } from './sql.ts';

class NodeSql implements Sql {
  readonly #db: DatabaseSync;
  constructor(file: string, options: OpenOptions = {}) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    for (const [name, other] of Object.entries(options.attach ?? {})) {
      this.#db.exec(`ATTACH DATABASE '${other.replaceAll("'", "''")}' AS ${name}`);
    }
  }
  exec(sql: string): void {
    this.#db.exec(sql);
  }
  prepare(sql: string): Statement {
    const statement = this.#db.prepare(sql);
    return {
      all: (...params: SqlParam[]) => statement.all(...params.map(sqlParam)) as Row[],
      get: (...params: SqlParam[]) => statement.get(...params.map(sqlParam)) as Row | undefined,
      run: (...params: SqlParam[]) => {
        const result = statement.run(...params.map(sqlParam));
        return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
      },
    };
  }
  get inTransaction(): boolean {
    return this.#db.isTransaction;
  }
  transaction<T>(fn: () => T): T {
    // IMMEDIATE takes the write lock now, so a read followed by a write cannot
    // be the loser of a lock upgrade against another connection.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    this.#db.close();
  }
}

export const nodeSql: SqlHost = { open: (file, options) => new NodeSql(file, options) };
