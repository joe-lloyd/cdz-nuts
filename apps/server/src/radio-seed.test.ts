import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSongRadioSeed } from './radio-seed.ts';

const mbid = 'aaaaaaaa-0000-4000-8000-000000000001';
const artistMbid = 'bbbbbbbb-0000-4000-8000-000000000002';

test('a catalog song resolves its recording before requesting similar songs', async () => {
  const asked: string[][] = [];
  const seed = await resolveSongRadioSeed({ from: 'spotify-song' }, id => {
    assert.equal(id, 'spotify-song');
    return { title: 'Seed Song', artist: 'Seed Artist' };
  }, async (artist, title) => {
    asked.push([artist, title]);
    return { recordingMbid: mbid, artistMbids: [artistMbid] };
  });
  assert.deepEqual(asked, [['Seed Artist', 'Seed Song']]);
  assert.deepEqual(seed, { title: 'Seed Song', artist: 'Seed Artist', recordingMbid: mbid, artistMbid });
});

test('identified library songs keep their recording and authoritative metadata', async () => {
  const seed = await resolveSongRadioSeed({ from: 'libtrack-song', title: 'Wrong', artist: 'Wrong' }, () => ({
    title: 'Library Song', artist: 'Library Artist', recordingMbid: mbid, artistMbid,
  }), async () => { throw new Error('identified songs must not be looked up again'); });
  assert.equal(seed?.recordingMbid, mbid);
  assert.equal(seed?.artistMbid, artistMbid);
  assert.equal(seed?.title, 'Library Song');
});

test('a radio candidate can seed another station before it is in the catalog', async () => {
  const seed = await resolveSongRadioSeed({
    from: `radio-${mbid}`, title: 'Candidate', artist: 'Candidate Artist', recordingMbid: mbid,
  }, () => null, async () => { throw new Error('known recording must skip lookup'); });
  assert.equal(seed?.title, 'Candidate');
  assert.equal(seed?.recordingMbid, mbid);
});

test('lookup misses and outages preserve an artist fallback', async () => {
  for (const lookup of [async () => null, async () => { throw new Error('offline'); }]) {
    const seed = await resolveSongRadioSeed({ from: 'song' }, () => ({ title: 'Song', artist: 'Artist' }), lookup);
    assert.equal(seed?.artist, 'Artist');
    assert.equal(seed?.recordingMbid, null);
  }
});

test('unknown songs without usable metadata do not invent a seed', async () => {
  assert.equal(await resolveSongRadioSeed({ from: 'unknown' }, () => null, async () => null), null);
});

test('known recording identity wins over conflicting URL metadata', async () => {
  const seed = await resolveSongRadioSeed({ from: 'held', recordingMbid: 'wrong' }, () => ({
    title: 'Song', artist: 'Artist', recordingMbid: mbid,
  }), async () => { throw new Error('must not look up a known recording'); });
  assert.equal(seed?.recordingMbid, mbid);
});

test('full artist credit is tried first, including band names containing an ampersand', async () => {
  const asked: string[] = [];
  const seed = await resolveSongRadioSeed({ from: 'song' }, () => ({
    title: 'The Sound of Silence', artist: 'Simon & Garfunkel',
  }), async artist => { asked.push(artist); return { recordingMbid: mbid, artistMbids: [] }; });
  assert.deepEqual(asked, ['Simon & Garfunkel']);
  assert.equal(seed?.recordingMbid, mbid);
});

test('a missing full credit or lookup failure can still use the lead artist', async () => {
  for (const fail of [false, true]) {
    const asked: string[] = [];
    const seed = await resolveSongRadioSeed({ from: 'song' }, () => ({
      title: 'Song', artist: 'Artist & Guest',
    }), async artist => {
      asked.push(artist);
      if (artist !== 'Artist') { if (fail) throw new Error('offline'); return null; }
      return { recordingMbid: mbid, artistMbids: [] };
    });
    assert.deepEqual(asked, ['Artist & Guest', 'Artist']);
    assert.equal(seed?.recordingMbid, mbid);
  }
});
