// TypeSafe System One: typed judgements over a JSON state.
//
// The model selects and scores, it never writes text. Every candidate answer
// has to be in `criteria`, and there has to be a way to say "none of these".
// Code owns the workflow; this file owns the HTTP contract and nothing else.
// https://docs.typesafe.ai/api

import { readFileSync } from 'node:fs';

export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_MODEL = 'jev-latest';

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string | Record<string, unknown> | unknown[];
  /** option -> what it means. Both the key and the text reach the model. */
  criteria: Record<string, string | Record<string, unknown> | null>;
}

export interface ChoiceAnswer {
  choice: string;
  /** Every option to its probability; they sum to 1. */
  probabilities: Record<string, number>;
  /** 0..1, how peaked `probabilities` is. Not "how right". */
  confidence: number;
}

export interface Judgement<Q extends string> {
  model: string;
  answers: Record<Q, ChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
}

export class TypeSafeError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'TypeSafeError';
    this.status = status;
  }
}

/** The API key, by file first (the compose convention) then by value. */
export function typeSafeKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env.TYPESAFE_API_KEY_FILE;
  if (file) {
    try { return readFileSync(file, 'utf8').trim() || null; } catch { return null; }
  }
  return env.TYPESAFE_API_KEY?.trim() || null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseChoice(id: string, raw: unknown): ChoiceAnswer {
  if (!isRecord(raw) || raw.type !== 'choice') throw new TypeSafeError(`answer ${id} is not a choice`);
  const { choice, probabilities, confidence } = raw;
  if (typeof choice !== 'string' || !isRecord(probabilities) || typeof confidence !== 'number') {
    throw new TypeSafeError(`answer ${id} is malformed`);
  }
  const parsed: Record<string, number> = {};
  for (const [option, p] of Object.entries(probabilities)) {
    if (typeof p !== 'number') throw new TypeSafeError(`answer ${id}: probability for ${option} is not a number`);
    parsed[option] = p;
  }
  if (!(choice in parsed)) throw new TypeSafeError(`answer ${id}: choice ${choice} is not an option`);
  return { choice, probabilities: parsed, confidence };
}

export class TypeSafe {
  readonly model: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;

  constructor(key: string, model: string = TYPESAFE_MODEL, fetchImpl: typeof fetch = fetch) {
    this.key = key;
    this.model = model;
    this.fetchImpl = fetchImpl;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): TypeSafe | null {
    const key = typeSafeKeyFromEnv(env);
    return key ? new TypeSafe(key) : null;
  }

  /**
   * Ask several Choice questions over one state. They run in parallel on the
   * model's side and cost tokens each, so batch what the caller will use and
   * no more. Retries 429 and 529 with backoff, as the API docs ask.
   */
  async choices<Q extends string>(state: unknown, questions: Record<Q, ChoiceQuestion>): Promise<Judgement<Q>> {
    const body = JSON.stringify({ state, model: this.model, questions });
    const started = Date.now();
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt) await new Promise((r) => setTimeout(r, 1_000 * 2 ** (attempt - 1)));
      const res = await this.fetchImpl(TYPESAFE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
        body,
      });
      lastStatus = res.status;
      if (res.status === 429 || res.status === 529) continue;
      const text = await res.text();
      if (!res.ok) throw new TypeSafeError(`TypeSafe ${res.status}: ${text.slice(0, 300)}`, res.status);
      const raw: unknown = JSON.parse(text);
      if (!isRecord(raw) || !isRecord(raw.answers) || !isRecord(raw.usage)) throw new TypeSafeError('response is not a judgement');
      const answers = {} as Record<Q, ChoiceAnswer>;
      for (const id of Object.keys(questions) as Q[]) answers[id] = parseChoice(id, raw.answers[id]);
      const { input_tokens, output_tokens } = raw.usage;
      return {
        model: typeof raw.model === 'string' ? raw.model : this.model,
        answers,
        usage: {
          input_tokens: typeof input_tokens === 'number' ? input_tokens : 0,
          output_tokens: typeof output_tokens === 'number' ? output_tokens : 0,
        },
        latencyMs: Date.now() - started,
      };
    }
    throw new TypeSafeError(`TypeSafe kept answering ${lastStatus}; gave up`, lastStatus);
  }
}
