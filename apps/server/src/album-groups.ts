// One card per record.
//
// Album identity here is a Spotify id, and Spotify lists one record several
// times: a regional duplicate, a remaster, a deluxe edition, each with its own
// id. The artist page showed every row, so Porcupine Tree had Recordings
// twice and Deadwing beside Deadwing (Remastered).
//
// This module decides which rows are the same record. Two rules live in code
// because they are rules: the same normalised title in the same year is the
// same release, and a title that differs only by an edition marker is another
// edition. What is left is judgement (is "CLOSURE / CONTINUATION. LIVE." an
// edition of "CLOSURE / CONTINUATION"? no, it is a live album), and that goes
// to TypeSafe as one Choice question per candidate pair. Every verdict is
// kept with its probabilities, so a nightly run never asks twice and the
// thresholds can be re-argued without re-asking.
//
// Nothing is deleted or rewritten. `album_group` sits beside `albums`, and the
// query layer folds members under their canonical row when it serves a page.

import { DatabaseSync } from 'node:sqlite';

import { normalizeMusicText } from './jellyfin.ts';
import type { ChoiceAnswer, ChoiceQuestion, TypeSafe } from './typesafe.ts';

export interface AlbumRow {
  id: string;
  name: string;
  album_type: string | null;
  release_date: string | null;
  total_tracks: number | null;
  label: string | null;
  is_saved: number;
}

export type Relation = 'same_release' | 'edition';
export type MemberRelation = 'canonical' | Relation;
export type Source = 'exact' | 'marker' | 'typesafe';

export interface GroupMember {
  album_id: string;
  group_id: string;
  relation: MemberRelation;
  source: Source;
  /** Probability behind a TypeSafe edge; null for a rule. */
  p: number | null;
}

export interface PairVerdict {
  a: string;
  b: string;
  choice: string;
  p_same_release: number;
  p_edition: number;
  p_different: number;
  confidence: number;
  model: string;
}

/** Below this the model's answer is recorded but not acted on. */
export const ACCEPT_P = 0.8;

/** Questions per request. Keeps one prolific artist from being one huge call. */
export const PAIRS_PER_REQUEST = 40;

// "(2017 Remaster)", "[Deluxe Edition]", " - Remastered", "(Deluxe - Remastered)".
// Not "(Live)", not "(Demo)": those are different records, not editions.
const MARKER = /\b(\d{4}\s+)?(re-?master(ed)?|deluxe|expanded|anniversary|bonus tracks?|re-?issue|special|collector'?s|legacy|edition)\b/i;

/** The title with edition markers removed, for telling editions apart. */
export function plainName(name: string): string {
  let out = name;
  out = out.replace(/\s*[([][^)\]]*[)\]]\s*$/g, (seg) => (MARKER.test(seg) ? '' : seg));
  out = out.replace(/\s*[([][^)\]]*[)\]]/g, (seg) => (MARKER.test(seg) ? '' : seg));
  out = out.replace(/\s+-\s+[^-]*$/, (seg) => (MARKER.test(seg) ? '' : seg));
  return out.trim();
}

export const nameKey = (name: string): string => normalizeMusicText(name);
export const hasMarker = (name: string): boolean => nameKey(plainName(name)) !== nameKey(name);
const year = (date: string | null): string => (date ?? '').slice(0, 4);

/** What code alone can say about a pair; null means "ask". */
export function codeRelation(a: AlbumRow, b: AlbumRow): Relation | null {
  if ((a.album_type ?? '') !== (b.album_type ?? '')) return null;
  if (nameKey(a.name) === nameKey(b.name) && year(a.release_date) === year(b.release_date)) return 'same_release';
  // Only when a marker is what differs. The same bare title in another year
  // could be a re-recording or an unrelated album, and that is a judgement.
  if ((hasMarker(a.name) || hasMarker(b.name)) && nameKey(plainName(a.name)) === nameKey(plainName(b.name))) return 'edition';
  return null;
}

const STOP = new Set(['a', 'an', 'the']);
function firstWord(name: string): string {
  return nameKey(plainName(name)).split(' ').find((w) => w && !STOP.has(w)) ?? '';
}

export type Pair = [AlbumRow, AlbumRow];

// Singles are left to the rules. A remix single of a song shares its first
// word with the original and with every other remix, and each is a different
// recording, so asking would burn most of the budget answering "different".
const JUDGED_TYPES = new Set(['album', 'compilation']);

/** Same-type album pairs sharing a first word that code could not settle. */
export function candidatePairs(albums: AlbumRow[]): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i < albums.length; i += 1) {
    for (let j = i + 1; j < albums.length; j += 1) {
      const a = albums[i];
      const b = albums[j];
      if (!JUDGED_TYPES.has(a.album_type ?? '')) continue;
      if ((a.album_type ?? '') !== (b.album_type ?? '')) continue;
      const word = firstWord(a.name);
      if (!word || word !== firstWord(b.name)) continue;
      if (codeRelation(a, b) !== null) continue;
      pairs.push([a, b]);
    }
  }
  return pairs;
}

const pairKey = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);
const questionId = (i: number, j: number): string => `pair_${i}_${j}`;

/**
 * One request per artist: the state lists every album that is in some pair,
 * and one Choice per pair points at two of them. Independent questions over
 * one state run in parallel on the model side and share the state's tokens.
 */
export function artistJudgement(artist: string, pairs: Pair[]): { state: unknown; questions: Record<string, ChoiceQuestion>; ids: Map<string, Pair> } {
  const involved = [...new Map(pairs.flat().map((a) => [a.id, a])).values()];
  const index = new Map(involved.map((a, i) => [a.id, i]));
  const state = {
    artist,
    albums: involved.map((a, i) => ({
      index: i,
      title: a.name,
      released: a.release_date,
      tracks: a.total_tracks,
      type: a.album_type,
      label: a.label,
    })),
  };
  const questions: Record<string, ChoiceQuestion> = {};
  const ids = new Map<string, Pair>();
  for (const pair of pairs) {
    const i = index.get(pair[0].id)!;
    const j = index.get(pair[1].id)!;
    const id = questionId(i, j);
    ids.set(id, pair);
    questions[id] = {
      type: 'choice',
      instructions: {
        question: `Is \`albums[${i}]\` the same record as \`albums[${j}]\`?`,
        judge_by: 'The two titles, their release dates and their track counts. A shared word in the title is not enough; a live recording, compilation or demo collection of an album is a different record from that album.',
      },
      criteria: {
        same_release: 'The same album listed twice: the same title apart from case or punctuation, the same year, about the same number of tracks. Typically a regional or catalogue duplicate.',
        edition: 'The same album in another edition: remastered, deluxe, expanded, anniversary, or with bonus tracks. The original track list is there, possibly extended, under a title that adds an edition marker.',
        different: 'A different record that shares words in its title: a live recording, a compilation or best-of, a demo or outtake collection, a sequel, or an unrelated album.',
      },
    };
  }
  return { state, questions, ids };
}

/** Turn an answer into a verdict row; the relation it licenses, if any. */
export function verdictOf(pair: Pair, answer: ChoiceAnswer, model: string): { verdict: PairVerdict; relation: Relation | null } {
  const [a, b] = pairKey(pair[0].id, pair[1].id);
  const verdict: PairVerdict = {
    a, b,
    choice: answer.choice,
    p_same_release: answer.probabilities.same_release ?? 0,
    p_edition: answer.probabilities.edition ?? 0,
    p_different: answer.probabilities.different ?? 0,
    confidence: answer.confidence,
    model,
  };
  return { verdict, relation: relationOf(verdict) };
}

export function relationOf(verdict: PairVerdict): Relation | null {
  const p = verdict.choice === 'same_release' ? verdict.p_same_release : verdict.choice === 'edition' ? verdict.p_edition : 0;
  if (verdict.choice === 'different' || p < ACCEPT_P) return null;
  return verdict.choice;
}

export interface Edge { a: string; b: string; source: Source; p: number | null }

/**
 * Union the edges into groups and name a canonical row per group: the
 * earliest release without an edition marker, a saved one winning ties.
 * Groups of one are not rows; absence means "its own record".
 */
export function buildGroups(albums: AlbumRow[], edges: Edge[]): GroupMember[] {
  const byId = new Map(albums.map((a) => [a.id, a]));
  const parent = new Map<string, string>();
  const joinedBy = new Map<string, Edge>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const edge of edges) {
    if (!byId.has(edge.a) || !byId.has(edge.b)) continue;
    const ra = find(edge.a);
    const rb = find(edge.b);
    if (ra === rb) continue;
    parent.set(ra, rb);
    if (!parent.has(rb)) parent.set(rb, rb);
    if (!joinedBy.has(edge.a)) joinedBy.set(edge.a, edge);
    if (!joinedBy.has(edge.b)) joinedBy.set(edge.b, edge);
  }
  const groups = new Map<string, AlbumRow[]>();
  for (const album of albums) {
    if (!parent.has(album.id)) continue;
    const root = find(album.id);
    groups.set(root, [...(groups.get(root) ?? []), album]);
  }
  const rank = (a: AlbumRow): [number, string, number, number, string] =>
    [hasMarker(a.name) ? 1 : 0, a.release_date || '9999', -a.is_saved, -(a.total_tracks ?? 0), a.id];
  const members: GroupMember[] = [];
  for (const rows of groups.values()) {
    const canonical = [...rows].sort((x, y) => {
      const rx = rank(x);
      const ry = rank(y);
      for (let k = 0; k < rx.length; k += 1) if (rx[k] !== ry[k]) return rx[k] < ry[k] ? -1 : 1;
      return 0;
    })[0];
    for (const row of rows) {
      const via = joinedBy.get(row.id);
      members.push({
        album_id: row.id,
        group_id: canonical.id,
        relation: row.id === canonical.id ? 'canonical'
          : nameKey(row.name) === nameKey(canonical.name) ? 'same_release' : 'edition',
        source: via?.source ?? 'exact',
        p: via?.p ?? null,
      });
    }
  }
  return members;
}

export interface GroupRun {
  artists: number;
  albums: number;
  ruleEdges: number;
  pairsCandidate: number;
  pairsAsked: number;
  pairsCached: number;
  accepted: number;
  rejected: number;
  groups: number;
  members: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  errors: string[];
}

export class AlbumGroupStore {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS album_group (
        album_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        relation TEXT NOT NULL CHECK (relation IN ('canonical', 'same_release', 'edition')),
        source TEXT NOT NULL CHECK (source IN ('exact', 'marker', 'typesafe')),
        p REAL,
        grouped_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS album_group_group ON album_group(group_id);
      CREATE TABLE IF NOT EXISTS album_pair_verdicts (
        a TEXT NOT NULL,
        b TEXT NOT NULL,
        choice TEXT NOT NULL,
        p_same_release REAL NOT NULL,
        p_edition REAL NOT NULL,
        p_different REAL NOT NULL,
        confidence REAL NOT NULL,
        model TEXT NOT NULL,
        judged_at TEXT NOT NULL,
        PRIMARY KEY (a, b)
      );
    `);
  }

  close(): void { this.db.close(); }

  /** Every artist with at least two albums, with those albums. */
  artists(only?: string): { id: string; name: string; albums: AlbumRow[] }[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT a.id AS artist_id, a.name AS artist, al.id, al.name, al.album_type,
             al.release_date, al.total_tracks, al.label, al.is_saved
      FROM artists a
      JOIN (SELECT artist_id, album_id FROM artist_albums
            UNION SELECT artist_id, album_id FROM album_artists) link ON link.artist_id = a.id
      JOIN albums al ON al.id = link.album_id
      WHERE al.removed_at IS NULL ${only ? 'AND a.name = ?' : ''}
      ORDER BY a.id, al.release_date, al.id
    `).all(...(only ? [only] : [])) as (AlbumRow & { artist_id: string; artist: string })[];
    const out = new Map<string, { id: string; name: string; albums: AlbumRow[] }>();
    for (const { artist_id, artist, ...album } of rows) {
      const entry = out.get(artist_id) ?? { id: artist_id, name: artist, albums: [] };
      entry.albums.push({ ...album, is_saved: Number(album.is_saved) });
      out.set(artist_id, entry);
    }
    return [...out.values()].filter((a) => a.albums.length > 1);
  }

  verdict(a: string, b: string): PairVerdict | null {
    const [x, y] = pairKey(a, b);
    return (this.db.prepare('SELECT * FROM album_pair_verdicts WHERE a = ? AND b = ?').get(x, y) as PairVerdict | undefined) ?? null;
  }

  saveVerdict(v: PairVerdict): void {
    this.db.prepare(`
      INSERT INTO album_pair_verdicts (a, b, choice, p_same_release, p_edition, p_different, confidence, model, judged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(a, b) DO UPDATE SET choice = excluded.choice, p_same_release = excluded.p_same_release,
        p_edition = excluded.p_edition, p_different = excluded.p_different, confidence = excluded.confidence,
        model = excluded.model, judged_at = excluded.judged_at
    `).run(v.a, v.b, v.choice, v.p_same_release, v.p_edition, v.p_different, v.confidence, v.model, new Date().toISOString());
  }

  /** Replace the membership rows for these albums with the given ones. */
  replaceMembers(albumIds: string[], members: GroupMember[]): void {
    const now = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      const del = this.db.prepare('DELETE FROM album_group WHERE album_id = ?');
      for (const id of albumIds) del.run(id);
      const ins = this.db.prepare('INSERT OR REPLACE INTO album_group (album_id, group_id, relation, source, p, grouped_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const m of members) ins.run(m.album_id, m.group_id, m.relation, m.source, m.p, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  verdicts(): PairVerdict[] {
    return this.db.prepare('SELECT * FROM album_pair_verdicts ORDER BY judged_at').all() as PairVerdict[];
  }
}

/**
 * Group one artist's albums. Rules first, then the model for what is left,
 * reading cached verdicts before asking. `client` null means rules only.
 */
export async function groupArtist(
  store: AlbumGroupStore,
  artist: { id: string; name: string; albums: AlbumRow[] },
  client: TypeSafe | null,
  run: GroupRun,
  options: { write?: boolean; log?: (line: string) => void } = {},
): Promise<{ members: GroupMember[]; verdicts: PairVerdict[] }> {
  const { albums } = artist;
  const edges: Edge[] = [];
  for (let i = 0; i < albums.length; i += 1) {
    for (let j = i + 1; j < albums.length; j += 1) {
      const rel = codeRelation(albums[i], albums[j]);
      if (rel) edges.push({ a: albums[i].id, b: albums[j].id, source: rel === 'same_release' ? 'exact' : 'marker', p: null });
    }
  }
  run.ruleEdges += edges.length;

  const verdicts: PairVerdict[] = [];
  const pairs = candidatePairs(albums);
  run.pairsCandidate += pairs.length;
  const toAsk: Pair[] = [];
  for (const pair of pairs) {
    const cached = store.verdict(pair[0].id, pair[1].id);
    if (cached) {
      run.pairsCached += 1;
      verdicts.push(cached);
    } else {
      toAsk.push(pair);
    }
  }
  for (let start = 0; client && start < toAsk.length; start += PAIRS_PER_REQUEST) {
    const chunk = toAsk.slice(start, start + PAIRS_PER_REQUEST);
    const { state, questions, ids } = artistJudgement(artist.name, chunk);
    try {
      const judgement = await client.choices(state, questions);
      run.requests += 1;
      run.pairsAsked += chunk.length;
      run.inputTokens += judgement.usage.input_tokens;
      run.outputTokens += judgement.usage.output_tokens;
      run.latencyMs += judgement.latencyMs;
      for (const [id, pair] of ids) {
        const { verdict } = verdictOf(pair, judgement.answers[id], judgement.model);
        if (options.write !== false) store.saveVerdict(verdict);
        verdicts.push(verdict);
      }
    } catch (error) {
      run.errors.push(`${artist.name}: ${(error as Error).message}`);
      options.log?.(`  ${artist.name}: ${(error as Error).message}`);
    }
  }
  for (const v of verdicts) {
    const rel = relationOf(v);
    if (rel) {
      run.accepted += 1;
      edges.push({ a: v.a, b: v.b, source: 'typesafe', p: v.choice === 'edition' ? v.p_edition : v.p_same_release });
    } else {
      run.rejected += 1;
    }
  }

  const members = buildGroups(albums, edges);
  if (options.write !== false) store.replaceMembers(albums.map((a) => a.id), members);
  run.artists += 1;
  run.albums += albums.length;
  run.groups += new Set(members.map((m) => m.group_id)).size;
  run.members += members.length;
  return { members, verdicts };
}

export const emptyRun = (): GroupRun => ({
  artists: 0, albums: 0, ruleEdges: 0, pairsCandidate: 0, pairsAsked: 0, pairsCached: 0, accepted: 0, rejected: 0,
  groups: 0, members: 0, requests: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, errors: [],
});
