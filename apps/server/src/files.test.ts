import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fakeDisk } from './fake-disk.ts';
import { diskFiles, guardFiles } from './files.ts';

function folder(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'files-'));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('names with spaces, hashes, question marks, percent signs and accents survive the trip through the disk binding', async () => {
  const { root, dispose } = folder();
  try {
    const names = ['01 Intro.flac', 'A#1 (Live?).flac', '100% Pure.flac', 'Sigur Rós – Ágætis.flac', 'a+b&c=d.flac'];
    mkdirSync(path.join(root, 'Artist & Co'));
    for (const name of names) writeFileSync(path.join(root, 'Artist & Co', name), name);
    const files = diskFiles([{ prefix: '/music', disk: fakeDisk(root) }]);
    const listed = await files.list('/music/Artist & Co');
    assert.deepEqual(listed?.map((e) => e.name).sort(), [...names].sort());
    for (const name of names) {
      assert.equal(new TextDecoder().decode((await files.read(`/music/Artist & Co/${name}`))!), name);
      assert.equal((await files.stat(`/music/Artist & Co/${name}`))?.size, Buffer.byteLength(name));
    }
  } finally {
    dispose();
  }
});

test('a missing file or folder is null, and a path outside every mount is null', async () => {
  const { root, dispose } = folder();
  try {
    const files = diskFiles([{ prefix: '/music', disk: fakeDisk(root) }]);
    assert.equal(await files.read('/music/nope.jpg'), null);
    assert.equal(await files.stat('/music/nope.jpg'), null);
    assert.equal(await files.list('/music/nope'), null);
    assert.equal(await files.read('/elsewhere/x'), null);
    assert.equal(await files.stat('/musicbox/x'), null, 'a prefix matches whole segments only');
  } finally {
    dispose();
  }
});

test('a write creates its folders; a read-only mount refuses it', async () => {
  const { root, dispose } = folder();
  try {
    const writable = diskFiles([{ prefix: '/images', disk: fakeDisk(root) }]);
    await writable.write('/images/albums/a1.jpg', new Uint8Array([1, 2, 3]));
    assert.deepEqual([...(await writable.read('/images/albums/a1.jpg'))!], [1, 2, 3]);
    const readOnly = diskFiles([{ prefix: '/images', disk: fakeDisk(root, { readOnly: true }) }]);
    await assert.rejects(readOnly.write('/images/albums/a2.jpg', new Uint8Array([1])), /403/);
  } finally {
    dispose();
  }
});

test('stat reports the modification time the disk gave, to the second', async () => {
  const { root, dispose } = folder();
  try {
    writeFileSync(path.join(root, 'a.flac'), 'x');
    const { utimesSync } = await import('node:fs');
    utimesSync(path.join(root, 'a.flac'), 1_700_000_000, 1_700_000_000);
    const files = diskFiles([{ prefix: '/music', disk: fakeDisk(root) }]);
    assert.equal((await files.stat('/music/a.flac'))?.mtimeMs, 1_700_000_000_000);
  } finally {
    dispose();
  }
});

test('the guard never touches the library while the source is offline, and asks again after the ttl', async () => {
  const touched: string[] = [];
  const inner = {
    async list(dir: string) { touched.push(`list ${dir}`); return []; },
    async stat(p: string) { touched.push(`stat ${p}`); return { size: 1, mtimeMs: 1 }; },
    async read(f: string) { touched.push(`read ${f}`); return new Uint8Array(); },
    async write(f: string) { touched.push(`write ${f}`); },
  };
  let online = false;
  let asked = 0;
  let clock = 0;
  const files = guardFiles(inner, '/music', async () => { asked += 1; return online; }, 5_000, () => clock);

  assert.equal(await files.list('/music/Artist'), null);
  assert.equal(await files.read('/music/Artist/cover.jpg'), null);
  assert.equal(await files.stat('/music/Artist/cover.jpg'), null);
  await assert.rejects(files.write('/music/x', new Uint8Array()), /unavailable/);
  assert.deepEqual(touched, []);
  assert.equal(asked, 1, 'one probe answers every call inside the ttl');

  // The images folder is not the library: never gated.
  assert.deepEqual(await files.list('/images/albums'), []);
  assert.equal(asked, 1);

  online = true;
  clock = 6_000;
  assert.deepEqual(await files.list('/music/Artist'), []);
  assert.equal(asked, 2);
  assert.deepEqual(touched, ['list /images/albums', 'list /music/Artist']);
});
