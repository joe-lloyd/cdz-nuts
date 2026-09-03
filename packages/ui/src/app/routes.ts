// The URL space, in one place.
//
// This is the list the server-side fallbacks are really about: music-dump and
// the Tauri shell both have to answer "is this a client route or a 404?", and
// neither can import TypeScript. They answer it by exclusion instead -- anything
// that is not an API path and not a known asset is handed to the app -- so this
// table is documentation and router config, not a shared contract. Keep it
// honest anyway; it is the only written record of what the app answers to.

/** Top-level tabs. The path is the tab id, which is also the nav button's key. */
export const TABS = {
  overview: 'Overview',
  radio: 'Radio',
  latest: 'Latest',
  artists: 'Artists',
  liked: 'Songs',
  albums: 'Albums',
  playlists: 'Playlists',
  top: 'Top',
  shows: 'Shows',
  cds: 'CDs',
  upgrades: 'FLAC queue',
  plays: 'Plays',
} as const;

export type TabId = keyof typeof TABS;

/** Detail routes, each taking one id. */
export const DETAIL_PATHS = ['artist', 'album', 'playlist'] as const;

/** Station kinds, which take a free-text seed rather than an id. */
export const STATION_KINDS = ['artist', 'tag', 'track', 'stats', 'recs'] as const;

/**
 * Rewrite a pre-rewrite `#hash` URL to its path equivalent.
 *
 * Every URL in this app used to be a hash, and those are bookmarked, sitting in
 * the phone app's WebView history, and linked from the dashboard. Dropping them
 * would break all of that silently -- a hash the router does not recognise just
 * renders the overview, so the failure looks like "it went to the wrong page"
 * rather than an error anyone would report.
 *
 * Returns null when there is nothing to migrate.
 */
export function pathFromLegacyHash(hash: string): string | null {
  const route = hash.replace(/^#/, '');
  if (!route) return null;
  // Only migrate shapes the old router actually served. Anything else is left
  // alone so a genuine in-page anchor (#main, from the skip link) still works.
  const known =
    route in TABS ||
    DETAIL_PATHS.some((p) => route.startsWith(`${p}/`)) ||
    route.startsWith('radio/');
  return known ? `/${route}` : null;
}
