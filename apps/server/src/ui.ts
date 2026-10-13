// The front end the app serves: packages/ui's routes.json says which URL is
// which file and type, and a reader supplies the bytes. Node reads packages/ui
// off the disk (ui-node.ts); the Worker reads the same files through an assets
// binding. Both go through makeUi(), so the manifest is applied in one place.

export type UiEntry = { file: string; type: string; cacheControl: string };
export type UiManifest = {
  document: UiEntry & { urls: string[] };
  static: Record<string, UiEntry>;
};

export type UiFile = { type: string; cacheControl: string; read(): Promise<Uint8Array | null> };

export interface Ui {
  /** The URLs that answer with the single-page document. */
  documentUrls: readonly string[];
  document: UiFile;
  /** The asset behind a URL such as /app.js, if the manifest names one. */
  asset(url: string): UiFile | undefined;
  /** A digest of every file the manifest names, to tell which build a host is serving. */
  digest(): Promise<string>;
}

export function makeUi(manifest: UiManifest, read: (file: string) => Promise<Uint8Array | null>): Ui {
  const file = (entry: UiEntry): UiFile => ({ type: entry.type, cacheControl: entry.cacheControl, read: () => read(entry.file) });
  let digest: Promise<string> | null = null;
  return {
    documentUrls: manifest.document.urls,
    document: file(manifest.document),
    asset: (url) => (Object.hasOwn(manifest.static, url) ? file(manifest.static[url]) : undefined),
    digest() {
      // Computed once: these files only change when the host restarts.
      digest ??= (async () => {
        // Sorted by BASENAME, which is the one ordering both hosts can agree on:
        // the absolute paths differ between a Node checkout and an embedded Rust
        // directory, the file names do not. Compared with < rather than
        // localeCompare, because the Rust side sorts bytes and localeCompare is
        // free to disagree with that under a different locale.
        const entries = [manifest.document, ...Object.values(manifest.static)]
          .map((entry) => [entry.file.slice(entry.file.lastIndexOf('/') + 1), entry.file] as const)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const parts: Uint8Array[] = [];
        for (const [name, path] of entries) {
          parts.push(new TextEncoder().encode(name));
          const bytes = await read(path);
          if (!bytes) throw new Error(`the UI file ${path} cannot be read`);
          parts.push(bytes);
        }
        const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
        let at = 0;
        for (const part of parts) { all.set(part, at); at += part.length; }
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
        return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      })();
      return digest;
    },
  };
}
