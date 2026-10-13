// Durable Object storage on node:sqlite, for the tests. It refuses what the
// real thing refuses (measured on workerd 1.20261006.1): BEGIN and SAVEPOINT,
// ATTACH, TEMP tables, the journal_mode and busy_timeout pragmas, bindings
// that are bigint, and more than 100 bound parameters. A boolean binds as the text "true", as it does there.
import { DatabaseSync } from 'node:sqlite';
import type { DurableObjectStorage } from './sql-do.ts';

const REFUSED = [
  [/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/im, 'use state.storage.transactionSync() instead of SQL transactions'],
  [/\bATTACH\s+DATABASE\b/i, 'not authorized'],
  [/\bCREATE\s+TEMP(ORARY)?\b/i, 'not authorized'],
  [/\bPRAGMA\s+(journal_mode|busy_timeout)\b/i, 'not authorized'],
] as const;

export function fakeDurableObjectStorage(): DurableObjectStorage {
  const db = new DatabaseSync(':memory:');
  return {
    sql: {
      exec(query, ...bindings) {
        // Measured on workerd 1.20261006.1: 100 bound parameters a statement, and LIKE patterns up to 50 bytes.
        if (bindings.length > 100) throw new Error('too many SQL variables');
        if (/\bLIKE\b/i.test(query) && bindings.some((v) => typeof v === 'string' && new TextEncoder().encode(v).length > 50 && /%/.test(v))) throw new Error('LIKE or GLOB pattern too complex');
        for (const [pattern, why] of REFUSED) if (pattern.test(query)) throw new Error(`SQLITE_AUTH: ${why}`);
        const values = bindings.map((value) => {
          if (typeof value === 'bigint') throw new Error('Cannot convert a BigInt value to a number');
          if (typeof value === 'boolean') return String(value);
          return (value === undefined ? null : value) as string | number | null;
        });
        // node:sqlite runs a multi-statement script only through exec(); a single statement gets its rows.
        const rows = bindings.length === 0 && /;\s*\S/.test(query.trim().replace(/;\s*$/, ''))
          ? (db.exec(query), [])
          : db.prepare(query).all(...values).map((row) => ({ ...row }));
        return { toArray: () => rows };
      },
    },
    transactionSync(fn) {
      db.exec('SAVEPOINT durable');
      try {
        const result = fn();
        db.exec('RELEASE durable');
        return result;
      } catch (error) {
        db.exec('ROLLBACK TO durable');
        db.exec('RELEASE durable');
        throw error;
      }
    },
  };
}
