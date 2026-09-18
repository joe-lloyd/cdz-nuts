// Which recording, on which release, is this file?
//
// Lidarr stamps every file it imports with a MusicBrainz recording id, so
// for most of the library "do we own this recording" is an index lookup
// (lidarr_recording). The files it never touched, the singles folders and the
// YouTube pulls, have only their tags, and libAlbumId() gives them a fake
// album from the folder they sit in. That is how _Singles/Porcupine Tree
// rendered as one 140-track record with someone else's cover.
//
// This module gives those files an identity beside the folder id, never
// instead of it. Code finds candidate recordings on MusicBrainz and prunes
// them; TypeSafe picks the one the file is, or `none`; code then picks the
// release the file belongs to from the recording's releases, preferring the
// album the tag names. Verdicts are stored with their probabilities so the
// nightly job never asks about a file twice.

import { DatabaseSync } from 'node:sqlite';

import { nameKey, plainName } from './album-groups.ts';
import { lengthsDisagree } from './jellyfin.ts';
import { mbGet, sleep } from './musicbrainz.ts';
import type { ChoiceAnswer, ChoiceQuestion, TypeSafe } from './typesafe.ts';

export interface FileToIdentify {
  path: string;
  artist: string;
  title: string;
  album: string | null;
  track_number: number | null;
  duration_ms: number | null;
}

export interface CandidateRelease {
  releaseMbid: string;
  releaseGroupMbid: string | null;
  title: string;
  date: string | null;
  status: string | null;
  type: string | null;
  secondaryTypes: string[];
  trackNumber: string | null;
}

export interface Candidate {
  recordingMbid: string;
  title: string;
  lengthMs: number | null;
  disambiguation: string;
  releases: CandidateRelease[];
}

export interface FileVerdict {
  path: string;
  choice: string;
  recording_mbid: string | null;
  release_mbid: string | null;
  release_group_mbid: string | null;
  release_title: string | null;
  release_type: string | null;
  p: number;
  p_none: number;
  confidence: number;
  candidates: number;
  model: string;
}

export const ACCEPT_P = 0.8;
export const MAX_CANDIDATES = 12;
export const FILES_PER_REQUEST = 6;

/**
 * The title as MusicBrainz will have it: qualifiers a tagger appends after
 * a dash or in brackets ("- Live", "- 2017 Remaster", "(Radio Edit)") are
 * disambiguations or release facts there, not part of the recording title.
 * The full title still goes to the model; this only shapes the search.
 */
export function searchTitle(title: string): string {
  return title
    .replace(/\s+-\s+(live|demo|remaster(ed)?|\d{4}\s+remaster(ed)?|radio edit|video edit|single (version|edit)|acoustic|instrumental)\b.*$/i, '')
    .replace(/\s*[([](live|demo|remaster(ed)?|\d{4}\s+remaster(ed)?|radio edit|video edit|single (version|edit)|short version|extended version|acoustic|instrumental)[^)\]]*[)\]]\s*$/i, '')
    .trim() || title;
}

function escapeLucene(term: string): string {
  return term.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Parse one MusicBrainz search hit into a candidate; null if unusable. */
export function parseRecording(raw: unknown): Candidate | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
  const releases: CandidateRelease[] = [];
  for (const rel of Array.isArray(raw.releases) ? raw.releases : []) {
    if (!isRecord(rel) || typeof rel.id !== 'string') continue;
    const rg = isRecord(rel['release-group']) ? rel['release-group'] : {};
    const media = Array.isArray(rel.media) && isRecord(rel.media[0]) ? rel.media[0] : {};
    const track = Array.isArray(media.track) && isRecord(media.track[0]) ? media.track[0] : {};
    releases.push({
      releaseMbid: rel.id,
      releaseGroupMbid: str(rg.id),
      title: str(rel.title) ?? '',
      date: str(rel.date),
      status: str(rel.status),
      type: str(rg['primary-type']),
      secondaryTypes: Array.isArray(rg['secondary-types']) ? rg['secondary-types'].filter((t): t is string => typeof t === 'string') : [],
      trackNumber: str(track.number),
    });
  }
  return {
    recordingMbid: raw.id,
    title: raw.title,
    lengthMs: typeof raw.length === 'number' ? raw.length : null,
    disambiguation: str(raw.disambiguation) ?? '',
    releases,
  };
}

/**
 * Candidates for a file, pruned. Bootleg-only recordings go first to the
 * back and then off the list: the library holds official material. A
 * recording whose length disagrees with the file is not the same recording,
 * so it is dropped too. What is left is ordered by how well its releases
 * match the album tag and how close its length is, and capped.
 */
export function pruneCandidates(file: FileToIdentify, candidates: Candidate[]): Candidate[] {
  const albumKey = nameKey(file.album ?? '');
  const scored = candidates
    .map((c) => ({ ...c, releases: c.releases.filter((r) => r.status !== 'Bootleg') }))
    .filter((c) => c.releases.length && !lengthsDisagree(c.lengthMs, file.duration_ms))
    .map((c) => {
      const tagMatch = albumKey && c.releases.some((r) => nameKey(r.title) === albumKey) ? 1 : 0;
      const delta = c.lengthMs && file.duration_ms ? Math.abs(c.lengthMs - file.duration_ms) : 60_000;
      return { c, tagMatch, delta };
    })
    .sort((x, y) => y.tagMatch - x.tagMatch || x.delta - y.delta);
  return scored.slice(0, MAX_CANDIDATES).map((s) => s.c);
}

/** True when a release title is the album the tag names, allowing for edition markers and subtitles. */
export function releaseMatchesTag(tag: string | null, releaseTitle: string): boolean {
  const want = nameKey(plainName(tag ?? ''));
  if (!want) return false;
  const have = nameKey(releaseTitle);
  return have === want || have.startsWith(`${want} `) || nameKey(plainName(releaseTitle)) === want;
}

/**
 * Search with the album tag first: it narrows "Anesthetize" from every
 * bootleg of the song to the record the file says it is from. Without a tag,
 * or when the tagged search finds nothing, search on title and artist alone.
 */
export async function candidatesFor(file: FileToIdentify, get: typeof mbGet = mbGet, pace: () => Promise<void> = async () => {}): Promise<Candidate[]> {
  const base = `recording:"${escapeLucene(searchTitle(file.title))}" AND artist:"${escapeLucene(file.artist)}"`;
  const tag = plainName(file.album ?? '');
  const queries = tag ? [`${base} AND release:"${escapeLucene(tag)}"`, base] : [base];
  for (const [i, q] of queries.entries()) {
    if (i) await pace();
    const res: unknown = await get('recording', { query: q, limit: '25' });
    const hits = isRecord(res) && Array.isArray(res.recordings) ? res.recordings : [];
    const candidates = pruneCandidates(file, hits.map(parseRecording).filter((c): c is Candidate => c !== null));
    if (candidates.length) return candidates;
  }
  return [];
}

/**
 * What code can settle without asking: exactly one candidate, its release
 * is the album the tag names, and the length agrees. Everything else is a
 * judgement.
 */
export function ruleVerdict(file: FileToIdentify, candidates: Candidate[]): FileVerdict | null {
  if (candidates.length !== 1) return null;
  const [c] = candidates;
  if (!file.duration_ms || !c.lengthMs || lengthsDisagree(c.lengthMs, file.duration_ms)) return null;
  const release = c.releases.find((r) => releaseMatchesTag(file.album, r.title) && r.status !== 'Bootleg');
  if (!release) return null;
  return {
    path: file.path, choice: 'rule', recording_mbid: c.recordingMbid, release_mbid: release.releaseMbid,
    release_group_mbid: release.releaseGroupMbid, release_title: release.title,
    release_type: [release.type, ...release.secondaryTypes].filter(Boolean).join(' / ') || null,
    p: 1, p_none: 0, confidence: 1, candidates: 1, model: 'rule',
  };
}

export interface Judged { file: FileToIdentify; candidates: Candidate[] }

/**
 * One request for several files. The state lists each file with its
 * candidates; one Choice per file names the candidate it is, or none.
 */
export function fileJudgement(items: Judged[]): { state: unknown; questions: Record<string, ChoiceQuestion>; ids: Map<string, Judged> } {
  const seconds = (ms: number | null) => (ms == null ? null : Math.round(ms / 1000));
  const state = {
    files: items.map(({ file, candidates }, i) => ({
      index: i,
      title: file.title,
      artist: file.artist,
      album_tag: file.album,
      track_number: file.track_number,
      length_seconds: seconds(file.duration_ms),
      filename: file.path.slice(file.path.lastIndexOf('/') + 1),
      candidates: candidates.map((c, j) => ({
        option: `c${j}`,
        title: c.title,
        disambiguation: c.disambiguation || null,
        length_seconds: seconds(c.lengthMs),
        // Computed here so the model does not have to fuzzy-match titles.
        on_the_album_the_tag_names: c.releases.some((r) => releaseMatchesTag(file.album, r.title)),
        releases: c.releases.slice(0, 6).map((r) => ({
          title: r.title, date: r.date, type: [r.type, ...r.secondaryTypes].filter(Boolean).join(' / ') || null, track: r.trackNumber,
        })),
      })),
    })),
  };
  const questions: Record<string, ChoiceQuestion> = {};
  const ids = new Map<string, Judged>();
  items.forEach((item, i) => {
    const id = `file_${i}`;
    ids.set(id, item);
    const criteria: Record<string, string> = {};
    item.candidates.forEach((c, j) => {
      const rel = c.releases[0];
      criteria[`c${j}`] = `${c.title}${c.disambiguation ? ` (${c.disambiguation})` : ''}, ${seconds(c.lengthMs) ?? '?'} s, on ${rel?.title ?? '?'}${rel?.type ? ` [${rel.type}]` : ''}${c.releases.length > 1 ? ` and ${c.releases.length - 1} more` : ''}`;
    });
    criteria.none = 'None of the candidates is this recording. Choose this when the file is a different take, version or edit than every candidate; when the file is a live recording and no candidate is from the same performance; or when the album tag names a record and no candidate is on it while the candidates are other performances of the song.';
    questions[id] = {
      type: 'choice',
      instructions: {
        question: `Which candidate recording is \`files[${i}]\`?`,
        judge_by: 'The title including any live, demo, remaster, edit or version qualifier; the length, since a different recording of the same song differs by more than a few seconds; and whether the candidate is on the album the tag names (`on_the_album_the_tag_names`). A live take is not the studio take, a demo is not the album version, a radio edit is not the full recording, and a live recording from one concert is not the same recording as one from another concert even at the same length.',
      },
      criteria,
    };
  });
  return { state, questions, ids };
}

/** The release the file belongs to among the chosen recording's releases. */
export function chooseRelease(file: FileToIdentify, candidate: Candidate): CandidateRelease | null {
  const official = candidate.releases.filter((r) => r.status === 'Official' || r.status === null);
  const pool = official.length ? official : candidate.releases;
  const tagged = pool.find((r) => releaseMatchesTag(file.album, r.title));
  if (tagged) return tagged;
  // Otherwise the earliest dated release; a single or the album, whichever
  // came first, is the record this recording was made for.
  return [...pool].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))[0] ?? null;
}

export function verdictOf(item: Judged, answer: ChoiceAnswer, model: string): FileVerdict {
  const index = /^c(\d+)$/.exec(answer.choice);
  const candidate = index ? item.candidates[Number(index[1])] : undefined;
  const p = answer.probabilities[answer.choice] ?? 0;
  const accepted = candidate && p >= ACCEPT_P;
  const release = accepted ? chooseRelease(item.file, candidate) : null;
  return {
    path: item.file.path,
    choice: answer.choice,
    recording_mbid: accepted ? candidate.recordingMbid : null,
    release_mbid: release?.releaseMbid ?? null,
    release_group_mbid: release?.releaseGroupMbid ?? null,
    release_title: release?.title ?? null,
    release_type: release ? [release.type, ...release.secondaryTypes].filter(Boolean).join(' / ') || null : null,
    p,
    p_none: answer.probabilities.none ?? 0,
    confidence: answer.confidence,
    candidates: item.candidates.length,
    model,
  };
}

export interface IdentifyRun {
  files: number;
  searched: number;
  noCandidates: number;
  byRule: number;
  asked: number;
  identified: number;
  none: number;
  belowThreshold: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  errors: string[];
}

export const emptyRun = (): IdentifyRun => ({
  files: 0, searched: 0, noCandidates: 0, byRule: 0, asked: 0, identified: 0, none: 0, belowThreshold: 0,
  requests: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, errors: [],
});

export class FileIdentityStore {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_release (
        path TEXT PRIMARY KEY,
        choice TEXT NOT NULL,
        recording_mbid TEXT,
        release_mbid TEXT,
        release_group_mbid TEXT,
        release_title TEXT,
        release_type TEXT,
        p REAL NOT NULL,
        p_none REAL NOT NULL,
        confidence REAL NOT NULL,
        candidates INTEGER NOT NULL,
        model TEXT NOT NULL,
        judged_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS file_release_recording ON file_release(recording_mbid);
      CREATE INDEX IF NOT EXISTS file_release_group ON file_release(release_group_mbid);
    `);
    // Columns added after the table first shipped, the way provenance.ts does it.
    const have = new Set((this.db.prepare('PRAGMA table_info(file_release)').all() as { name: string }[]).map((c) => c.name));
    for (const [column, type] of [['release_type', 'TEXT']]) {
      if (!have.has(column)) this.db.exec(`ALTER TABLE file_release ADD COLUMN ${column} ${type}`);
    }
  }

  close(): void { this.db.close(); }

  /**
   * Files worth identifying that have no verdict yet: everything in a
   * singles or YouTube folder, plus any file whose artist+title key another
   * file also carries, since those are the ones name matching gets wrong.
   */
  pending(only?: string): FileToIdentify[] {
    return this.db.prepare(`
      SELECT p.path, p.artist, p.title, p.album, p.track_number, p.duration_ms
      FROM track_provenance p
      LEFT JOIN file_release f ON f.path = p.path
      WHERE f.path IS NULL
        AND (p.path LIKE '%/\\_Singles/%' ESCAPE '\\' OR p.path LIKE '%/\\_YouTube/%' ESCAPE '\\'
             OR p.match_key IN (SELECT match_key FROM track_provenance GROUP BY match_key HAVING COUNT(*) > 1))
        ${only ? 'AND p.artist = ?' : ''}
      ORDER BY p.artist, p.path
    `).all(...(only ? [only] : [])) as FileToIdentify[];
  }

  save(v: FileVerdict): void {
    this.db.prepare(`
      INSERT INTO file_release (path, choice, recording_mbid, release_mbid, release_group_mbid, release_title, release_type, p, p_none, confidence, candidates, model, judged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET choice = excluded.choice, recording_mbid = excluded.recording_mbid,
        release_mbid = excluded.release_mbid, release_group_mbid = excluded.release_group_mbid,
        release_title = excluded.release_title, release_type = excluded.release_type, p = excluded.p, p_none = excluded.p_none,
        confidence = excluded.confidence, candidates = excluded.candidates, model = excluded.model, judged_at = excluded.judged_at
    `).run(v.path, v.choice, v.recording_mbid, v.release_mbid, v.release_group_mbid, v.release_title, v.release_type, v.p, v.p_none, v.confidence, v.candidates, v.model, new Date().toISOString());
  }

  /** A file that has no candidates at all is recorded so it is not searched nightly. */
  saveUnmatched(path: string): void {
    this.save({ path, choice: 'no-candidates', recording_mbid: null, release_mbid: null, release_group_mbid: null, release_title: null, release_type: null, p: 0, p_none: 1, confidence: 1, candidates: 0, model: 'none' });
  }

  /** Recording MBID -> path for the identified files. */
  pathsByRecording(mbids: string[]): Map<string, string> {
    const wanted = [...new Set(mbids.filter(Boolean).map((m) => m.toLowerCase()))];
    if (!wanted.length) return new Map();
    const marks = wanted.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT recording_mbid, path FROM file_release WHERE recording_mbid IN (${marks})`).all(...wanted) as { recording_mbid: string; path: string }[];
    return new Map(rows.map((r) => [r.recording_mbid.toLowerCase(), r.path]));
  }

  byPath(path: string): FileVerdict | null {
    return (this.db.prepare('SELECT * FROM file_release WHERE path = ?').get(path) as FileVerdict | undefined) ?? null;
  }

  verdicts(): FileVerdict[] {
    return this.db.prepare('SELECT * FROM file_release ORDER BY judged_at').all() as FileVerdict[];
  }
}

/**
 * Identify a batch of files: search each (one MusicBrainz call a second),
 * settle what a rule can, then ask about the rest a few files per request.
 * `audit` sends rule-decided files to the model too, to measure agreement.
 */
export async function identifyFiles(
  store: FileIdentityStore,
  files: FileToIdentify[],
  client: TypeSafe | null,
  run: IdentifyRun,
  options: { write?: boolean; audit?: boolean; get?: typeof mbGet; pace?: number; log?: (line: string) => void; onVerdict?: (v: FileVerdict, item: Judged) => void } = {},
): Promise<FileVerdict[]> {
  const get = options.get ?? mbGet;
  const pace = options.pace ?? 1_100;
  const wait = get === mbGet ? () => sleep(pace) : async () => {};
  const out: FileVerdict[] = [];
  const judged: Judged[] = [];
  for (const file of files) {
    run.files += 1;
    try {
      const candidates = await candidatesFor(file, get, wait);
      run.searched += 1;
      const byRule = ruleVerdict(file, candidates);
      if (!candidates.length) {
        run.noCandidates += 1;
        if (options.write !== false) store.saveUnmatched(file.path);
      } else if (byRule && !options.audit) {
        run.byRule += 1;
        if (options.write !== false) store.save(byRule);
        options.onVerdict?.(byRule, { file, candidates });
        out.push(byRule);
      } else {
        judged.push({ file, candidates });
      }
    } catch (error) {
      run.errors.push(`${file.path}: ${(error as Error).message}`);
      options.log?.(`  search failed: ${file.path}: ${(error as Error).message}`);
    }
    await wait();
  }
  for (let start = 0; client && start < judged.length; start += FILES_PER_REQUEST) {
    const chunk = judged.slice(start, start + FILES_PER_REQUEST);
    const { state, questions, ids } = fileJudgement(chunk);
    try {
      const judgement = await client.choices(state, questions);
      run.requests += 1;
      run.inputTokens += judgement.usage.input_tokens;
      run.outputTokens += judgement.usage.output_tokens;
      run.latencyMs += judgement.latencyMs;
      for (const [id, item] of ids) {
        const verdict = verdictOf(item, judgement.answers[id], judgement.model);
        run.asked += 1;
        if (verdict.recording_mbid) run.identified += 1;
        else if (verdict.choice === 'none') run.none += 1;
        else run.belowThreshold += 1;
        if (options.write !== false) store.save(verdict);
        options.onVerdict?.(verdict, item);
        out.push(verdict);
      }
    } catch (error) {
      run.errors.push(`judgement: ${(error as Error).message}`);
      options.log?.(`  judgement failed: ${(error as Error).message}`);
    }
  }
  return out;
}
