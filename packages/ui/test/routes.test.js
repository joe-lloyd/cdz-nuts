// The contract this package exists to hold: routes.json and the files on disk
// agree, and the document actually asks for the assets it declares. Two
// consumers in two languages read this manifest, so a rename that updates only
// one side has to fail here rather than in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { uiDir, indexHtml, staticFiles, documentUrls, allFiles } from '../index.js';

const manifest = JSON.parse(readFileSync(new URL('../routes.json', import.meta.url), 'utf8'));

test('every declared route resolves to a file that exists', () => {
  assert.ok(existsSync(indexHtml), `missing document: ${indexHtml}`);
  for (const [url, entry] of Object.entries(staticFiles)) {
    assert.ok(existsSync(entry.file), `route ${url} points at missing file ${entry.file}`);
  }
});

test('every file in public/ is declared in routes.json', () => {
  const onDisk = readdirSync(uiDir).sort();
  const declared = allFiles.map((f) => path.basename(f)).sort();
  assert.deepEqual(onDisk, declared, 'public/ and routes.json disagree — an undeclared file is dead weight, and a declared one that is gone is a 500');
});

test('the document serves from both / and /index.html', () => {
  assert.deepEqual(documentUrls, ['/', '/index.html']);
});

test('nothing is declared that the app never asks for', () => {
  // The document links app.css/player.js/sw.js/manifest; the manifest is what
  // names icon.svg. Checking both is the real contract — a route no one
  // references is dead weight, and this is how we notice.
  const sources = [
    readFileSync(indexHtml, 'utf8'),
    readFileSync(staticFiles['/manifest.webmanifest'].file, 'utf8'),
  ].join('\n');
  for (const url of Object.keys(staticFiles)) {
    assert.ok(sources.includes(url), `nothing references ${url}`);
  }
});

test('content types are explicit and charset-qualified where text', () => {
  const entries = [{ url: '(document)', ...manifest.document }, ...Object.entries(manifest.static).map(([url, e]) => ({ url, ...e }))];
  for (const entry of entries) {
    assert.match(entry.type, /^[a-z]+\/[a-z0-9.+-]+/, `${entry.url} has no usable content type`);
    if (entry.type.startsWith('text/')) {
      assert.match(entry.type, /charset=/, `${entry.url} is text and must name a charset`);
    }
  }
});
