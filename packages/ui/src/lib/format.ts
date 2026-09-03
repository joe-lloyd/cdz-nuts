// Small pure helpers, ported from the top of the old inline script.

/** "3:07" from milliseconds. */
export const dur = (ms: number | null | undefined): string => {
  const s = Math.round((ms ?? 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** "3:07" from seconds. The player's variant; tolerates NaN/Infinity. */
export const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const rounded = Math.floor(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
};

export const day = (iso: string | null | undefined): string => (iso ?? '').slice(0, 10);

export const ago = (iso: string): string => {
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

export const until = (iso: string): string => {
  const m = (new Date(iso).getTime() - Date.now()) / 60000;
  if (m <= 0) return 'due now';
  if (m < 60) return `in ${Math.max(1, Math.round(m))}m`;
  if (m < 1440) return `in ${Math.round(m / 60)}h`;
  return `in ${Math.round(m / 1440)}d`;
};

/**
 * The letter a missing cover falls back to.
 *
 * `(name ?? '?')[0]` looked safe and was not: `??` catches null and undefined
 * but not an EMPTY STRING, and `''[0]` is undefined, so `.toUpperCase()` threw
 * and took the whole page down with it. One track called "[intro]", whose
 * title-stripping reduces to nothing, was enough to break Latest entirely.
 */
export const initial = (name: string | null | undefined): string =>
  (String(name ?? '').trim()[0] ?? '?').toUpperCase();

export const genres = (json: string | null | undefined, n = 3): string[] => {
  try {
    const parsed: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(parsed) ? (parsed as string[]).slice(0, n) : [];
  } catch {
    return [];
  }
};

/** Ids the server serves art for directly, rather than the Spotify CDN. */
export const localArt = (id: string | null | undefined): boolean =>
  /^(localalbum|libalbum)-/.test(String(id ?? ''));

/** Where the app serves a cover from, given an album id. */
export const artUrl = (kind: 'albums' | 'artists', id: string | null | undefined): string => {
  if (!id) return '';
  return localArt(id) ? `/img/local/${encodeURIComponent(id)}.jpg` : `/img/${kind}/${encodeURIComponent(id)}.jpg`;
};

/** Only a library track has a recording id to seed a station from. */
export const seedable = (id: string | null | undefined): boolean => /^libtrack-/.test(String(id ?? ''));

/**
 * Strip the "(2026) [Album]" folder noise from a title — but never down to
 * nothing. A title that is entirely bracketed ("[intro]") is the real name.
 */
export const bareAlbumName = (raw: string | null | undefined): string => {
  const rawName = String(raw ?? '');
  const stripped = rawName
    .replace(/\s*[(\[]\d{4}[)\]].*$/, '')
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .trim();
  return stripped || rawName;
};

export const releaseDay = (iso: string): string => {
  const at = new Date(`${iso}T12:00:00`);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/** Squared gain curve; see the volume slider for why. Exactly invertible. */
export const gainFor = (position: number): number => Math.max(0, Math.min(1, Number(position))) ** 2;
export const positionFor = (gain: number): number => Math.sqrt(Math.max(0, Math.min(1, Number(gain))));

export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
