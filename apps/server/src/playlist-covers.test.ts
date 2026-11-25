import test from 'node:test';
import assert from 'node:assert/strict';
import { coverUrls, hostedCover, pickCovers } from './playlist-covers.ts';

const song = (album: string, image: string | null = null) => ({ album_id: album, image_url: image });

test('four covers from four different albums, never the same album twice', () => {
  const tracks = ['a', 'a', 'b', 'c', 'c', 'c', 'd', 'e', 'f'].map((album) => song(album));
  const covers = pickCovers(tracks);
  assert.equal(covers.length, 4);
  assert.equal(new Set(covers.map((c) => c.album_id)).size, 4);
  for (const cover of covers) assert.ok(['a', 'b', 'c', 'd', 'e', 'f'].includes(cover.album_id!));
});

test('fewer albums than four gives that many covers, and none gives none', () => {
  assert.equal(pickCovers([song('a'), song('b'), song('a')]).length, 2);
  assert.equal(pickCovers([song('a')]).length, 1);
  assert.deepEqual(pickCovers([]), []);
});

test('a playlist keeps its covers, whatever order its songs are in', () => {
  const tracks = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((album) => song(album));
  const first = pickCovers(tracks);
  assert.deepEqual(pickCovers(tracks), first);
  assert.deepEqual(pickCovers([...tracks].reverse()), first);
});

test('the pick is random rather than the first four albums', () => {
  // Forty playlists of twelve albums each. Were it the first four, every one
  // would show its albums 00 to 03.
  let firstFour = 0;
  const places = new Set<string>();
  for (let n = 0; n < 40; n += 1) {
    const tracks = Array.from({ length: 12 }, (_, i) => song(`p${n}-album-${String(i).padStart(2, '0')}`));
    const picked = pickCovers(tracks).map((c) => c.album_id!.slice(-2));
    if (picked.join(',') === '00,01,02,03') firstFour += 1;
    for (const place of picked) places.add(place);
  }
  assert.ok(firstFour < 2, 'the first four albums should not keep coming up');
  assert.equal(places.size, 12, 'every position in a playlist gets picked somewhere');
});

test('a song with no album and no image offers no cover', () => {
  const covers = pickCovers([{ album_id: null, image_url: null }, song('a'), { album_id: null, image_url: 'https://i.scdn.co/x' }]);
  assert.equal(covers.length, 2);
  assert.ok(covers.some((c) => c.album_id === null && c.image_url === 'https://i.scdn.co/x'));
});

test('hosted covers follow the same rule as the UI', () => {
  assert.equal(hostedCover('libalbum-abc123'), '/img/local/libalbum-abc123.jpg');
  assert.equal(hostedCover('localalbum-9'), '/img/local/localalbum-9.jpg');
  assert.equal(hostedCover('rg:1234-abcd'), '/img/local/rg%3A1234-abcd.jpg');
  assert.equal(hostedCover('4aawyAB9vmqN3uQ7FjRGTy'), '/img/albums/4aawyAB9vmqN3uQ7FjRGTy.jpg');
  assert.deepEqual(
    coverUrls([{ album_id: 'libalbum-1', image_url: null }, { album_id: null, image_url: 'https://cdn/x.jpg' }, { album_id: null, image_url: null }]),
    ['/img/local/libalbum-1.jpg', 'https://cdn/x.jpg'],
  );
});
