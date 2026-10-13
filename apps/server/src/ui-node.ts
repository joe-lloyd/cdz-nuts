// packages/ui off the disk, for the Node server. A relative path rather than a
// workspace package name: pi-server runs this straight off a bind mount with no
// install step, so there is no node_modules symlink to resolve through.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeUi, type UiManifest } from './ui.ts';

const UI_DIR = path.join(import.meta.dirname, '..', '..', '..', 'packages', 'ui');

export async function nodeUi() {
  const manifest = JSON.parse(await readFile(path.join(UI_DIR, 'routes.json'), 'utf8')) as UiManifest;
  return makeUi(manifest, async (file) => {
    try {
      return new Uint8Array(await readFile(path.join(UI_DIR, file)));
    } catch {
      return null;
    }
  });
}
