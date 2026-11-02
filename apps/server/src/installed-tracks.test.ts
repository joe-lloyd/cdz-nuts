import assert from 'node:assert/strict';
import test from 'node:test';
import { indexInstalledTracks, matchInstalledTrack } from './installed-tracks.ts';
import type { LocalTrack } from './upgrades.ts';
const track = (extra: Partial<LocalTrack>): LocalTrack => ({
  id: 'localtrack-1', album_id: 'album', name: 'Song', artists: 'Artist', album: 'Studio',
  duration_ms: 180000, track_number: null, codec: 'opus', standalone: true, path: '/file.opus', added_at: '', ...extra,
});

test('empty normalized titles cannot match an arbitrary installed file', () => {
  const index = indexInstalledTracks([track({ name: '日本語' }), track({ name: '中文' })]);
  assert.equal(index.size, 0);
  assert.equal(matchInstalledTrack(index, 'Artist', '別の曲'), undefined);
  assert.equal(matchInstalledTrack(index, '', ''), undefined);
});

test('same-name recordings use duration and album hints, retaining every indexed candidate', () => {
  const live = track({ id: 'live', album: 'Live', duration_ms: 500000 });
  const compilation = track({ id: 'compilation', album: 'Compilation' });
  const studio = track({ id: 'studio' });
  const index = indexInstalledTracks([live, compilation, studio]);
  assert.equal(matchInstalledTrack(index, 'Artist', 'Song', { album: 'Studio', durationMs: 180000 })?.id, 'studio');
  assert.equal(matchInstalledTrack(index, 'Artist', 'Song', { durationMs: 500000 })?.id, 'live');
  assert.equal(matchInstalledTrack(index, 'Artist', 'Song', { durationMs: 900000 }), undefined);
});
