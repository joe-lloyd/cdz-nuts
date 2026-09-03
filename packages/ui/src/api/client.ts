// The one place a request is made.
//
// Every URL stays ROOT-RELATIVE. That is the hinge the desktop shell turns on:
// it serves the app from a custom scheme and answers /api itself, so an
// absolute URL here would bypass the tunnel entirely. Do not introduce one.

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function parse<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : `request failed (${response.status})`;
    throw new ApiError(detail, response.status);
  }
  return body as T;
}

/** GET. Caching is TanStack Query's job, not this function's. */
export async function get<T>(path: string, init?: RequestInit): Promise<T> {
  return parse<T>(await fetch(path, init));
}

/** GET something that changes underneath us — worker state, player status. */
export async function getFresh<T>(path: string): Promise<T> {
  return get<T>(path, { cache: 'no-store' });
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  return parse<T>(await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

/** Build a query string, dropping empties so the server sees clean params. */
export const qs = (params: Record<string, string | number | null | undefined>): string => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};
