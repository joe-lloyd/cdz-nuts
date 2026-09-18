import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FileIdentityStore, chooseRelease, emptyRun, fileJudgement, identifyFiles, parseRecording, pruneCandidates,
  releaseMatchesTag, ruleVerdict, searchTitle, verdictOf, type Candidate, type FileToIdentify,
} from './file-identity.ts';
import { TypeSafe } from './typesafe.ts';

const file = (over: Partial<FileToIdentify> = {}): FileToIdentify => ({
  path: '/data/library/music/_Singles/Porcupine Tree/Trains - Live.opus',
  artist: 'Porcupine Tree', title: 'Trains - Live', album: 'Arriving Somewhere', track_number: null, duration_ms: 438_553,
  ...over,
});

const candidate = (over: Partial<Candidate> & { recordingMbid: string }): Candidate => ({
  title: 'Trains', lengthMs: 438_000, disambiguation: '', releases: [], ...over,
});

const release = (title: string, over: Partial<Candidate['releases'][number]> = {}) => ({
  releaseMbid: `rel-${title}`, releaseGroupMbid: `rg-${title}`, title, date: '2006-01-01', status: 'Official',
  type: 'Album', secondaryTypes: [], trackNumber: '1', ...over,
});

test('the search title drops tagger qualifiers and nothing else', () => {
  assert.equal(searchTitle('Trains - Live'), 'Trains');
  assert.equal(searchTitle('Blackest Eyes - 2017 Remaster'), 'Blackest Eyes');
  assert.equal(searchTitle('Radioactive Toy (Short Version) - Remastered'), 'Radioactive Toy');
  assert.equal(searchTitle('Trains (Radio Edit)'), 'Trains');
  assert.equal(searchTitle('The Sky Moves Sideways (Phase One)'), 'The Sky Moves Sideways (Phase One)');
  assert.equal(searchTitle('Mesmer III / Coma Divine'), 'Mesmer III / Coma Divine');
});

test('a MusicBrainz hit becomes a candidate with its releases and their groups', () => {
  const c = parseRecording({
    id: 'rec', title: 'Trains', length: 356_000, disambiguation: '',
    releases: [{
      id: 'rel', title: 'In Absentia', date: '2002-09-24', status: 'Official',
      'release-group': { id: 'rg', 'primary-type': 'Album', 'secondary-types': [] },
      media: [{ track: [{ number: '7' }] }],
    }],
  });
  assert.deepEqual(c, {
    recordingMbid: 'rec', title: 'Trains', lengthMs: 356_000, disambiguation: '',
    releases: [{ releaseMbid: 'rel', releaseGroupMbid: 'rg', title: 'In Absentia', date: '2002-09-24', status: 'Official', type: 'Album', secondaryTypes: [], trackNumber: '7' }],
  });
  assert.equal(parseRecording({ title: 'no id' }), null);
});

test('pruning drops bootleg-only and wrong-length recordings and puts the tagged album first', () => {
  const f = file();
  const pruned = pruneCandidates(f, [
    candidate({ recordingMbid: 'studio', lengthMs: 356_000, releases: [release('In Absentia')] }),
    candidate({ recordingMbid: 'boot', lengthMs: 438_000, releases: [release('2006-10-06: Rockpalast', { status: 'Bootleg' })] }),
    candidate({ recordingMbid: 'other-live', lengthMs: 440_000, releases: [release('Ilosaarirock')] }),
    candidate({ recordingMbid: 'arriving', lengthMs: 439_000, releases: [release('Arriving Somewhere')] }),
  ]);
  assert.deepEqual(pruned.map((c) => c.recordingMbid), ['arriving', 'other-live']);
});

test('a release matches the tag through markers and subtitles', () => {
  assert.equal(releaseMatchesTag('Stars Die (Remaster)', 'Stars Die: The Delerium Years 1991 – 1997'), true);
  assert.equal(releaseMatchesTag('Deadwing', 'Deadwing (Remastered)'), true);
  assert.equal(releaseMatchesTag('In Absentia (Deluxe - Remastered)', 'In Absentia'), true);
  assert.equal(releaseMatchesTag('Anesthetize', 'Atlanta'), false);
  assert.equal(releaseMatchesTag(null, 'Anything'), false);
});

test('one candidate on the tagged album at the right length is a rule, not a question', () => {
  const f = file();
  const only = candidate({ recordingMbid: 'arriving', lengthMs: 439_000, releases: [release('Arriving Somewhere')] });
  const v = ruleVerdict(f, [only]);
  assert.equal(v?.choice, 'rule');
  assert.equal(v?.release_group_mbid, 'rg-Arriving Somewhere');
  // Two candidates, or a candidate on some other record, is a question.
  assert.equal(ruleVerdict(f, [only, candidate({ recordingMbid: 'x', lengthMs: 439_000, releases: [release('Arriving Somewhere')] })]), null);
  assert.equal(ruleVerdict(f, [candidate({ recordingMbid: 'y', lengthMs: 439_000, releases: [release('Atlanta')] })]), null);
});

test('the release is the one the tag names, else the earliest official one', () => {
  const c = candidate({
    recordingMbid: 'r', releases: [
      release('Trains', { type: 'Single', date: '2003-01-01' }),
      release('In Absentia', { date: '2002-09-24' }),
      release('In Absentia (Remastered)', { date: '2017-01-01' }),
      release('Some Bootleg', { status: 'Bootleg', date: '2001-01-01' }),
    ],
  });
  assert.equal(chooseRelease(file({ album: 'In Absentia (Deluxe - Remastered)' }), c)?.title, 'In Absentia');
  assert.equal(chooseRelease(file({ album: null }), c)?.title, 'In Absentia');
  assert.equal(chooseRelease(file({ album: 'Trains' }), c)?.title, 'Trains');
});

test('the request lists files with their candidates and one question per file with a none option', () => {
  const items = [{ file: file(), candidates: [candidate({ recordingMbid: 'a', releases: [release('Arriving Somewhere')] }), candidate({ recordingMbid: 'b', releases: [release('Ilosaarirock')] })] }];
  const { state, questions, ids } = fileJudgement(items);
  const s = state as { files: { candidates: { option: string; on_the_album_the_tag_names: boolean }[] }[] };
  assert.deepEqual(s.files[0].candidates.map((c) => [c.option, c.on_the_album_the_tag_names]), [['c0', true], ['c1', false]]);
  assert.deepEqual(Object.keys(questions.file_0.criteria), ['c0', 'c1', 'none']);
  assert.equal(ids.get('file_0'), items[0]);
});

test('a verdict is identified only above the threshold, and carries the chosen release', () => {
  const item = { file: file(), candidates: [candidate({ recordingMbid: 'a', releases: [release('Arriving Somewhere')] })] };
  const yes = verdictOf(item, { choice: 'c0', probabilities: { c0: 0.9, none: 0.1 }, confidence: 0.85 }, 'jev');
  assert.equal(yes.recording_mbid, 'a');
  assert.equal(yes.release_title, 'Arriving Somewhere');
  const weak = verdictOf(item, { choice: 'c0', probabilities: { c0: 0.6, none: 0.4 }, confidence: 0.3 }, 'jev');
  assert.equal(weak.recording_mbid, null);
  assert.equal(weak.choice, 'c0');
  const none = verdictOf(item, { choice: 'none', probabilities: { c0: 0.2, none: 0.8 }, confidence: 0.7 }, 'jev');
  assert.equal(none.recording_mbid, null);
  assert.equal(none.p_none, 0.8);
});

test('identifyFiles searches with the tag, settles by rule, asks about the rest, and never asks twice', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'file-identity-'));
  const store = new FileIdentityStore(path.join(dir, 'provenance.db'));
  store.db.exec(`
    CREATE TABLE track_provenance (path TEXT PRIMARY KEY, match_key TEXT, artist TEXT, title TEXT, album TEXT, track_number INTEGER, duration_ms INTEGER);
    INSERT INTO track_provenance VALUES
      ('/lib/_Singles/PT/Trains - Live.opus', 'porcupine tree|trains', 'Porcupine Tree', 'Trains - Live', 'Arriving Somewhere', NULL, 438553),
      ('/lib/_Singles/PT/Anesthetize - Live.opus', 'porcupine tree|anesthetize', 'Porcupine Tree', 'Anesthetize - Live', 'Anesthetize', NULL, 1051373),
      ('/lib/PT/Deadwing/01 Deadwing.flac', 'porcupine tree|deadwing', 'Porcupine Tree', 'Deadwing', 'Deadwing', 1, 586000);
  `);
  const searches: string[] = [];
  const fakeGet = async (_path: string, params: Record<string, string>) => {
    searches.push(params.query);
    if (params.query.includes('"Trains"') && params.query.includes('release:')) {
      return { recordings: [{ id: 'trains-live', title: 'Trains', length: 438_000, disambiguation: 'live, 2005', releases: [{ id: 'as', title: 'Arriving Somewhere', status: 'Official', 'release-group': { id: 'rg-as', 'primary-type': 'Album' }, media: [{ track: [{ number: '9' }] }] }] }] };
    }
    if (params.query.includes('"Anesthetize"')) {
      return params.query.includes('release:') ? { recordings: [] } : { recordings: [
        { id: 'atl', title: 'Anesthetize', length: 1_050_000, disambiguation: 'live, 2007: Atlanta', releases: [{ id: 'atlanta', title: 'Atlanta', status: 'Official', 'release-group': { id: 'rg-atl', 'primary-type': 'Album' } }] },
        { id: 'studio', title: 'Anesthetize', length: 1_062_000, disambiguation: '', releases: [{ id: 'foabp', title: 'Fear of a Blank Planet', status: 'Official', 'release-group': { id: 'rg-foabp', 'primary-type': 'Album' } }] },
      ] };
    }
    return { recordings: [] };
  };
  let asked = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    asked += 1;
    const body = JSON.parse(String(init?.body));
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) answers[id] = { type: 'choice', choice: 'none', probabilities: { c0: 0.2, c1: 0.1, none: 0.7 }, confidence: 0.5 };
    return new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 400, output_tokens: 20 } }), { status: 200 });
  };
  try {
    const run = emptyRun();
    const verdicts = await identifyFiles(store, store.pending(), new TypeSafe('k', 'jev-test', fakeFetch), run, { get: fakeGet });
    // Only the singles files are pending; the Lidarr album file is not.
    assert.equal(run.files, 2);
    assert.ok(searches.includes('recording:"Trains" AND artist:"Porcupine Tree" AND release:"Arriving Somewhere"'), 'the tag narrows the first search');
    assert.equal(run.byRule, 1, 'Trains: one candidate on the tagged album, right length');
    assert.equal(run.asked, 1, 'Anesthetize: two candidates, neither on the tagged album');
    assert.equal(run.none, 1);
    assert.equal(asked, 1);
    const trains = verdicts.find((v) => v.path.endsWith('Trains - Live.opus'))!;
    assert.equal(trains.choice, 'rule');
    assert.equal(trains.release_title, 'Arriving Somewhere');
    assert.deepEqual([...store.pathsByRecording(['TRAINS-LIVE']).entries()], [['trains-live', '/lib/_Singles/PT/Trains - Live.opus']]);
    assert.equal(store.byPath('/lib/_Singles/PT/Anesthetize - Live.opus')?.choice, 'none');
    // Nothing is pending any more, so a second run searches nothing.
    assert.deepEqual(store.pending(), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
