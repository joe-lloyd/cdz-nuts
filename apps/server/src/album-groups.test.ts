import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ACCEPT_P, AlbumGroupStore, artistJudgement, buildGroups, candidatePairs, codeRelation, groupArtist,
  emptyRun, plainName, relationOf, type AlbumRow,
} from './album-groups.ts';
import { TypeSafe, TYPESAFE_URL } from './typesafe.ts';

const album = (over: Partial<AlbumRow> & { id: string; name: string }): AlbumRow => ({
  album_type: 'album', release_date: '2005-03-28', total_tracks: 9, label: null, is_saved: 0, ...over,
});

test('edition markers come off the title; live and demo do not', () => {
  assert.equal(plainName('Deadwing (Remastered)'), 'Deadwing');
  assert.equal(plainName('Trains (2017 Remaster)'), 'Trains');
  assert.equal(plainName('In Absentia (Deluxe - Remastered)'), 'In Absentia');
  assert.equal(plainName('Hybrid Theory [Bonus Edition]'), 'Hybrid Theory');
  assert.equal(plainName('Meteora - Remastered'), 'Meteora');
  assert.equal(plainName('Coma Divine (Live)'), 'Coma Divine (Live)');
  assert.equal(plainName('Stupid Dream Demos 1998/1999'), 'Stupid Dream Demos 1998/1999');
});

test('the two code rules: same title and year, or a title that differs only by a marker', () => {
  const deadwing = album({ id: 'a', name: 'Deadwing' });
  assert.equal(codeRelation(deadwing, album({ id: 'b', name: 'Deadwing (Remastered)' })), 'edition');
  assert.equal(codeRelation(album({ id: 'c', name: 'Recordings', release_date: '2001-01-01' }), album({ id: 'd', name: 'Recordings', release_date: '2001-01-01' })), 'same_release');
  // Same title, different year: a re-recording or a reissue, not something a rule can call.
  assert.equal(codeRelation(album({ id: 'e', name: 'Recordings', release_date: '2001-01-01' }), album({ id: 'f', name: 'Recordings', release_date: '2011-01-01' })), null);
  // A single is never the same record as an album.
  assert.equal(codeRelation(deadwing, album({ id: 'g', name: 'Deadwing', album_type: 'single' })), null);
  assert.equal(codeRelation(deadwing, album({ id: 'h', name: 'Deadwing Live' })), null);
});

test('pairs for the model share a first word, are albums, and are not rule-decided', () => {
  const albums = [
    album({ id: 'cc', name: 'CLOSURE / CONTINUATION', release_date: '2022-06-24', total_tracks: 10 }),
    album({ id: 'live', name: 'CLOSURE / CONTINUATION. LIVE. AMSTERDAM 07/11/22', release_date: '2023-12-08', total_tracks: 21 }),
    album({ id: 'dw', name: 'Deadwing' }),
    album({ id: 'dwr', name: 'Deadwing (Remastered)' }),
    album({ id: 'sky', name: 'The Sky Moves Sideways' }),
    album({ id: 'inc', name: 'The Incident' }),
    album({ id: 's1', name: 'Trains', album_type: 'single' }),
    album({ id: 's2', name: 'Trains (Remix)', album_type: 'single' }),
  ];
  const pairs = candidatePairs(albums).map(([a, b]) => `${a.id}~${b.id}`);
  // "The" is not a shared first word, Deadwing is settled by rule, singles are not asked.
  assert.deepEqual(pairs, ['cc~live']);
});

test('one request per artist carries every album in a pair and one question per pair', () => {
  const a = album({ id: 'a', name: 'Spindash', release_date: '2014-01-01' });
  const b = album({ id: 'b', name: 'Spindash 2', release_date: '2015-01-01' });
  const c = album({ id: 'c', name: 'Spindash 3', release_date: '2016-01-01' });
  const { state, questions, ids } = artistJudgement('GameChops', [[a, b], [a, c]]);
  assert.deepEqual((state as { albums: { title: string }[] }).albums.map((x) => x.title), ['Spindash', 'Spindash 2', 'Spindash 3']);
  assert.deepEqual(Object.keys(questions), ['pair_0_1', 'pair_0_2']);
  assert.equal(ids.get('pair_0_2')![1].id, 'c');
  assert.deepEqual(Object.keys(questions.pair_0_1.criteria), ['same_release', 'edition', 'different']);
});

test('a verdict acts only when the chosen relation clears the threshold', () => {
  const base = { a: 'a', b: 'b', p_same_release: 0, p_edition: 0, p_different: 0, confidence: 0.9, model: 'jev-latest' };
  assert.equal(relationOf({ ...base, choice: 'edition', p_edition: ACCEPT_P }), 'edition');
  assert.equal(relationOf({ ...base, choice: 'edition', p_edition: 0.79 }), null);
  assert.equal(relationOf({ ...base, choice: 'same_release', p_same_release: 0.95 }), 'same_release');
  assert.equal(relationOf({ ...base, choice: 'different', p_different: 1 }), null);
});

test('groups get the earliest plain release as canonical, and members say how they relate', () => {
  const albums = [
    album({ id: 'del2', name: 'In Absentia (Deluxe - Remastered)', release_date: '2002-09-24', total_tracks: 33, is_saved: 1 }),
    album({ id: 'del1', name: 'In Absentia (Deluxe - Remastered)', release_date: '2002', total_tracks: 33, is_saved: 1 }),
    album({ id: 'rem', name: 'In Absentia (Remastered)', release_date: '2002-09-24', total_tracks: 12 }),
    album({ id: 'plain', name: 'In Absentia', release_date: '2002-09-24', total_tracks: 12 }),
    album({ id: 'other', name: 'Lightbulb Sun', release_date: '2000-05-01' }),
  ];
  const members = buildGroups(albums, [
    { a: 'del1', b: 'del2', source: 'exact', p: null },
    { a: 'rem', b: 'del1', source: 'marker', p: null },
    { a: 'plain', b: 'rem', source: 'marker', p: null },
  ]);
  const byId = Object.fromEntries(members.map((m) => [m.album_id, m]));
  assert.equal(members.length, 4, 'Lightbulb Sun is its own record and gets no row');
  assert.equal(byId.plain.relation, 'canonical');
  assert.equal(byId.rem.group_id, 'plain');
  assert.equal(byId.rem.relation, 'edition');
  assert.equal(byId.del1.relation, 'edition');
  assert.equal(byId.del2.relation, 'edition');
});

test('with no plain release the earliest edition is canonical and its twin is a same_release', () => {
  const members = buildGroups([
    album({ id: 'x', name: 'Recordings', release_date: '2001-01-01' }),
    album({ id: 'y', name: 'Recordings', release_date: '2001-01-01', is_saved: 1 }),
  ], [{ a: 'x', b: 'y', source: 'exact', p: null }]);
  const canonical = members.find((m) => m.relation === 'canonical')!;
  assert.equal(canonical.album_id, 'y', 'the saved twin wins the tie');
  assert.equal(members.find((m) => m.album_id === 'x')!.relation, 'same_release');
});

test('groupArtist asks once, caches the verdict, and folds accepted answers into groups', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'album-groups-'));
  const file = path.join(dir, 'spotify.db');
  const store = new AlbumGroupStore(file);
  store.db.exec(`
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT, album_type TEXT, release_date TEXT, total_tracks INTEGER, label TEXT, is_saved INTEGER DEFAULT 0, removed_at TEXT);
    CREATE TABLE artist_albums (artist_id TEXT, album_id TEXT, album_group TEXT);
    CREATE TABLE album_artists (artist_id TEXT, album_id TEXT);
    INSERT INTO artists VALUES ('pt', 'Porcupine Tree');
    INSERT INTO albums (id, name, album_type, release_date, total_tracks) VALUES
      ('hs', 'Helter Skelter', 'album', '2010-01-01', 12),
      ('hsd', 'Helter Skelter: The Deluxe Edition', 'album', '2011-01-01', 18),
      ('hsh', 'Helter Skelter: The Hunter', 'album', '2013-01-01', 11);
    INSERT INTO artist_albums VALUES ('pt', 'hs', 'album'), ('pt', 'hsd', 'album'), ('pt', 'hsh', 'album');
  `);
  let calls = 0;
  const fakeFetch: typeof fetch = async (url, init) => {
    calls += 1;
    assert.equal(url, TYPESAFE_URL);
    const body = JSON.parse(String(init?.body));
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      const [, i, j] = id.split('_').map(Number);
      const titles = body.state.albums.map((x: { title: string }) => x.title);
      const deluxe = titles[i].includes('Deluxe') || titles[j].includes('Deluxe');
      const hunter = titles[i].includes('Hunter') || titles[j].includes('Hunter');
      answers[id] = deluxe && !hunter
        ? { type: 'choice', choice: 'edition', probabilities: { same_release: 0.05, edition: 0.9, different: 0.05 }, confidence: 0.88 }
        : { type: 'choice', choice: 'different', probabilities: { same_release: 0.02, edition: 0.08, different: 0.9 }, confidence: 0.88 };
    }
    return new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 500, output_tokens: 30 } }), { status: 200 });
  };
  const client = new TypeSafe('key', 'jev-test', fakeFetch);
  try {
    const [artist] = store.artists();
    const run = emptyRun();
    const { members } = await groupArtist(store, artist, client, run);
    assert.equal(calls, 1, 'three pairs, one request');
    assert.equal(run.pairsAsked, 3);
    assert.equal(run.accepted, 1);
    assert.equal(run.rejected, 2);
    const byId = Object.fromEntries(members.map((m) => [m.album_id, m]));
    assert.equal(byId.hs.relation, 'canonical');
    assert.equal(byId.hsd.relation, 'edition');
    assert.equal(byId.hsd.source, 'typesafe');
    assert.equal(byId.hsd.p, 0.9);
    assert.equal(byId.hsh, undefined, 'The Hunter is a different record');

    // The rows are in the table, and a second run asks nothing.
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM album_group').get()!.n, 2);
    const again = emptyRun();
    await groupArtist(store, artist, client, again);
    assert.equal(calls, 1);
    assert.equal(again.pairsCached, 3);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
