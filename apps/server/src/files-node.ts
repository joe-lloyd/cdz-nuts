// The real disk as a Files host, for local development and the tests.
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Files } from './files.ts';

export const nodeFiles: Files = {
  async list(dir) {
    try {
      return (await readdir(dir, { withFileTypes: true }))
        .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' as const : 'file' as const }));
    } catch {
      return null;
    }
  },
  async stat(at) {
    try {
      const info = await stat(at);
      return { size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  },
  async read(file) {
    try {
      return new Uint8Array(await readFile(file));
    } catch {
      return null;
    }
  },
  async write(file, body) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  },
};
