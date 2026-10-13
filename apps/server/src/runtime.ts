// What the host runtime gives the app. The Node server and the Worker each build
// one, call provideRuntime() once, and only then load app.ts, whose module
// scope builds the stores and reads this. There is one app per process, or per
// Durable Object, so one provided runtime is the honest shape.
import type { Files } from './files.ts';
import { provideSql, type SqlHost } from './sql.ts';
import type { Ui } from './ui.ts';

export interface Runtime {
  sql: SqlHost;
  /** The music library and the archived cover images, by absolute path. */
  files: Files;
  ui: Ui;
  /** Whether a TCP connection to host:port opens within a short time. */
  probe(host: string, port: number): Promise<boolean>;
}

let current: Runtime | null = null;

export function provideRuntime(runtime: Runtime): void {
  current = runtime;
  provideSql(runtime.sql);
}

export function runtime(): Runtime {
  if (!current) throw new Error('no runtime: the entry point must call provideRuntime() before loading the app');
  return current;
}
