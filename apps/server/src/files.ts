// The files the app reads and writes outside its databases: the music library
// (read-only, for cover art and the "latest downloads" walk) and the folder of
// archived cover images (written by the exporter, read by the web routes).
//
// Paths are absolute, as fs would have them. Node resolves them on the real
// disk. In workerd a path is cut into a mount and a path inside it: each mount
// is a disk binding, an HTTP fetcher over one folder. That is the whole of
// diskFiles(), and it is why this file imports nothing from node.

export type Entry = { name: string; kind: 'file' | 'directory' };
export type Stat = { size: number; mtimeMs: number };

export interface Files {
  /** Directory entries, or null when the folder cannot be read (missing, or eliot asleep). */
  list(dir: string): Promise<Entry[] | null>;
  /** Size and modification time of a file or folder, or null when it cannot be read. */
  stat(path: string): Promise<Stat | null>;
  /** A whole file, or null when it cannot be read. */
  read(file: string): Promise<Uint8Array | null>;
  /** Writes a file, creating its folders. Refuses a mount that was bound read-only. */
  write(file: string, body: Uint8Array): Promise<void>;
}

/** The part of a Worker binding diskFiles() needs. */
export type Fetcher = { fetch(input: string, init?: RequestInit): Promise<Response> };

/** A mount: the absolute folder the app knows it by, and the binding that serves it. */
export type Mount = { prefix: string; disk: Fetcher };

function relative(mount: Mount, path: string): string | null {
  if (path === mount.prefix) return '';
  if (!path.startsWith(`${mount.prefix}/`)) return null;
  return path.slice(mount.prefix.length + 1);
}

/** One URL per path, with every segment escaped so "#", "?" and "%" in a file name stay in the name. */
function urlFor(rel: string, folder = false): string {
  const encoded = rel.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `http://disk/${encoded}${folder && encoded ? '/' : ''}`;
}

export function diskFiles(mounts: readonly Mount[]): Files {
  const resolve = (path: string): { mount: Mount; rel: string } | null => {
    for (const mount of mounts) {
      const rel = relative(mount, path);
      if (rel !== null) return { mount, rel };
    }
    return null;
  };
  const modified = (response: Response): number => {
    const stamp = Date.parse(response.headers.get('last-modified') ?? '');
    return Number.isNaN(stamp) ? 0 : stamp;
  };
  return {
    async list(dir) {
      const at = resolve(dir);
      if (!at) return null;
      try {
        const response = await at.mount.disk.fetch(urlFor(at.rel, true));
        if (!response.ok) { await response.body?.cancel(); return null; }
        const entries: unknown = await response.json();
        if (!Array.isArray(entries)) return null;
        return entries.flatMap((entry): Entry[] => {
          const { name, type } = entry as { name?: unknown; type?: unknown };
          if (typeof name !== 'string') return [];
          return [{ name, kind: type === 'directory' ? 'directory' : 'file' }];
        });
      } catch {
        return null;
      }
    },
    async stat(path) {
      const at = resolve(path);
      if (!at) return null;
      try {
        const response = await at.mount.disk.fetch(urlFor(at.rel), { method: 'HEAD' });
        if (!response.ok) return null;
        return { size: Number(response.headers.get('content-length') ?? 0), mtimeMs: modified(response) };
      } catch {
        return null;
      }
    },
    async read(file) {
      const at = resolve(file);
      if (!at) return null;
      try {
        const response = await at.mount.disk.fetch(urlFor(at.rel));
        if (!response.ok) { await response.body?.cancel(); return null; }
        return new Uint8Array(await response.arrayBuffer());
      } catch {
        return null;
      }
    },
    async write(file, body) {
      const at = resolve(file);
      if (!at) throw new Error(`${file} is not under a mounted folder`);
      const response = await at.mount.disk.fetch(urlFor(at.rel), { method: 'PUT', body });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`writing ${file} failed (${response.status})`);
    },
  };
}
