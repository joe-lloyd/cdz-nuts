// music-ui — the shared front end of the music player.
//
// Node-side helper. It does one job: turn routes.json into absolute paths, so
// a server can mount the UI without knowing how it is laid out on disk. The
// Rust desktop shell reads the same routes.json directly; keeping the manifest
// language-neutral is the whole reason the two stay identical.
//
// There is no build step and there never should be. These are the files the
// browser gets, byte for byte.

import path from 'node:path';
import { readFileSync } from 'node:fs';

const HERE = import.meta.dirname;

/** @type {{ document: { urls: string[], file: string, type: string, cacheControl: string }, static: Record<string, { file: string, type: string, cacheControl: string }> }} */
const manifest = JSON.parse(readFileSync(path.join(HERE, 'routes.json'), 'utf8'));

/** Absolute path to the directory holding the served assets. */
export const uiDir = path.join(HERE, 'public');

/** Absolute path to the single-page document. */
export const indexHtml = path.join(HERE, manifest.document.file);

/** The URLs that should serve the document ("/" and "/index.html"). */
export const documentUrls = manifest.document.urls;

/** Content type to serve the document with. */
export const documentType = manifest.document.type;

/**
 * Route -> { file, type, cacheControl } for every non-document asset, with
 * `file` resolved to an absolute path. Shaped to drop straight into the
 * STATIC_FILES lookup the server already had.
 */
export const staticFiles = Object.fromEntries(
  Object.entries(manifest.static).map(([url, entry]) => [
    url,
    { ...entry, file: path.join(HERE, entry.file) },
  ]),
);

/** Every file this package serves, absolute. Useful for cache-busting and tests. */
export const allFiles = [indexHtml, ...Object.values(staticFiles).map((f) => f.file)];
