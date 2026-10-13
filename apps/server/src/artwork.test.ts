// The Albums page showed blank cards for records that had art on Latest,
// twice, because three request handlers each answered "what does this look
// like?" their own way. These pin the one answer they now share.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findCover, resolveArtwork } from './artwork.ts';
import { diskFiles, type Files } from './files.ts';
import { nodeFiles } from './files-node.ts';
import { fakeDisk } from './fake-disk.ts';

// Every case runs twice: on the real disk, and through the disk binding's HTTP
// (a fake over the same folder), because the Worker only has the second.
type Backend = 'node fs' | 'disk binding';
const BACKENDS: Backend[] = ['node fs', 'disk binding'];

function library(backend: Backend): { root: string; files: Files; add: (rel: string, at?: number) => string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'artwork-'));
  return {
    root,
    files: backend === 'node fs' ? nodeFiles : diskFiles([{ prefix: root, disk: fakeDisk(root) }]),
    add(rel, at) {
      const file = path.join(root, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'x');
      if (at !== undefined) utimesSync(file, at, at);
      return file;
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const backend of BACKENDS) test(`an ordinary album wears the cover in its folder (${backend})`, async () => {
  const lib = library(backend);
  try {
    const cover = lib.add('Tool/Lateralus (2001)/cover.jpg');
    lib.add('Tool/Lateralus (2001)/01 The Grudge.flac');
    const found = await resolveArtwork(lib.files, lib.root, path.join(lib.root, 'Tool/Lateralus (2001)'));
    assert.deepEqual(found, { file: cover, type: 'image/jpeg' });
  } finally {
    lib.dispose();
  }
});

for (const backend of BACKENDS) test(`a multi-disc release finds the cover a level up (${backend})`, async () => {
  const lib = library(backend);
  try {
    const cover = lib.add('Artist/Album (1999)/cover.jpg');
    lib.add('Artist/Album (1999)/CD 01/01 One.flac');
    const found = await findCover(lib.files, path.join(lib.root, 'Artist/Album (1999)/CD 01'), lib.root);
    assert.equal(found?.file, cover);
  } finally {
    lib.dispose();
  }
});

for (const backend of BACKENDS) test(`the search never climbs out of the library (${backend})`, async () => {
  const lib = library(backend);
  try {
    // A cover sitting beside the library must never become its art.
    const outside = path.join(lib.root, '..', `escape-${path.basename(lib.root)}.jpg`);
    writeFileSync(outside, 'x');
    try {
      assert.equal(await findCover(lib.files, lib.root, lib.root), null);
      assert.equal(await findCover(lib.files, path.join(lib.root, 'Artist'), lib.root), null);
    } finally {
      rmSync(outside, { force: true });
    }
  } finally {
    lib.dispose();
  }
});

// The bug: a locally imported single is ONE record living in a folder shared
// with a dozen unrelated singles, and it was resolved by looking for
// cover.jpg / folder.jpg - names a singles folder does not have. Every such
// card came back blank even though its sleeve was sitting right beside the
// audio.
for (const backend of BACKENDS) test(`a single in a shared folder wears its own sleeve (${backend})`, async () => {
  const lib = library(backend);
  try {
    const audio = lib.add('_Singles/Yppah/In My Drink.opus');
    const own = lib.add('_Singles/Yppah/In My Drink.jpg');
    lib.add('_Singles/Yppah/Someone Else Song.jpg');
    const found = await resolveArtwork(lib.files, lib.root, path.dirname(audio), audio);
    assert.deepEqual(found, { file: own, type: 'image/jpeg' }, 'must not borrow a sibling');
  } finally {
    lib.dispose();
  }
});

// The other half, from the previous round: keying a whole collection on one
// single whose art is missing blanked the card while its siblings held
// sleeves. A sibling's sleeve beats a blank.
for (const backend of BACKENDS) test(`a single with no art of its own borrows the freshest sibling (${backend})`, async () => {
  const lib = library(backend);
  try {
    const audio = lib.add('_Singles/Nosaj Thing/Fated.opus');
    lib.add('_Singles/Nosaj Thing/Old One.jpg', 1_600_000_000);
    const newest = lib.add('_Singles/Nosaj Thing/Newer One.jpg', 1_700_000_000);
    const found = await resolveArtwork(lib.files, lib.root, path.dirname(audio), audio);
    assert.equal(found?.file, newest);
  } finally {
    lib.dispose();
  }
});

for (const backend of BACKENDS) test(`a folder cover still wins over a stray sidecar (${backend})`, async () => {
  const lib = library(backend);
  try {
    const cover = lib.add('Artist/Album (2020)/cover.jpg');
    lib.add('Artist/Album (2020)/02 Track.jpg');
    const found = await resolveArtwork(lib.files, lib.root, path.join(lib.root, 'Artist/Album (2020)'));
    assert.equal(found?.file, cover, 'a whole-album cover speaks for the album');
  } finally {
    lib.dispose();
  }
});

for (const backend of BACKENDS) test(`a record with no art anywhere resolves to nothing (${backend})`, async () => {
  const lib = library(backend);
  try {
    const audio = lib.add('_Singles/Nobody/Untitled.opus');
    assert.equal(await resolveArtwork(lib.files, lib.root, path.dirname(audio), audio), null);
    assert.equal(await resolveArtwork(lib.files, lib.root, path.join(lib.root, 'does/not/exist')), null);
  } finally {
    lib.dispose();
  }
});
