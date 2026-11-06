// The URL space, in one place.
//
// This is the list the server-side fallbacks are really about: apps/server and
// the Tauri shell both have to answer "is this a client route or a 404?", and
// neither can import TypeScript. They answer it by exclusion instead -- anything
// that is not an API path and not a known asset is handed to the app -- so this
// table is documentation and router config, not a shared contract. Keep it
// honest anyway; it is the only written record of what the app answers to.

import type { ReactNode } from 'react';

/** Top-level tabs. The path is the tab id, which is also the nav button's key. */
/**
 * The sidebar list, and only that.
 *
 * Twelve entries did not fit a window that was not maximised, and what fell
 * off the bottom was the sidebar foot. Three came out rather than adding a
 * scrollbar and calling it fixed: Overview is where the logo goes, and Latest
 * and Radio are sections of Overview now, so they are one scroll from the
 * front page instead of a click from a list nobody could finish reading.
 * Their paths still work; see PAGE_COPY.
 */
export const TABS = {
  overview: 'Home',
  artists: 'Artists',
  albums: 'Albums',
  liked: 'Liked songs',
  playlists: 'Playlists',
  top: 'Top',
  shows: 'Shows',
  cds: 'CDs',
  upgrades: 'Requests',
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
    route in TABS || route === 'albums' ||
    DETAIL_PATHS.some((p) => route.startsWith(`${p}/`)) ||
    route.startsWith('radio/');
  return known ? `/${route}` : null;
}

/**
 * The eyebrow and heading each page shows in the page head.
 *
 * Keyed by path rather than by TabId: overview, latest and radio are still
 * real destinations with real URLs, they are simply not in the sidebar.
 */
export const PAGE_COPY: Record<string, [string, string]> = {
  overview: ['Your listening memory', 'The collection'],
  radio: ['Everything you have not heard yet', 'Radio'],
  latest: ['Freshly on disk', 'Latest downloads'],
  artists: ['Everyone in your orbit', 'Artists'],
  liked: ['Saved here and on Spotify', 'Liked songs'],
  albums: ['The record shelf', 'Albums'],
  playlists: ['Your hand-built paths', 'Playlists'],
  top: ['Listening, counted honestly', 'Your top music'],
  shows: ['Artists leaving the speakers', 'Upcoming shows'],
  cds: ['The discs on the shelf', 'CD collection'],
  upgrades: ['Downloads, then lossless (FLAC) copies', 'Requests'],
  plays: ['The latest signals', 'Recently played'],
};

/**
 * Pages that are not tabs.
 *
 * Settings is reached from the sidebar foot rather than the tab list: it is
 * not a view of the library, and putting it in the nav would push a
 * once-a-month page in front of the twelve you use daily.
 */
export const ASIDE_COPY: Record<string, [string, string]> = {
  settings: ['This app and this machine', 'About'],
};

export const NOT_FOUND_COPY: [string, string] = ['Nothing at this address', 'Page not found'];

export const SETTINGS_ICON: ReactNode = (
  <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></svg>
);

export const DETAIL_COPY = {
  artist: ['Artist in your archive', 'Artist'],
  album: ['Release in your archive', 'Album'],
  playlist: ['Playlist', 'Playlist'],
} as const;

/** Where a sub page goes back to when there is no history of ours behind us. */
export const PARENT_OF: Record<string, string> = {
  artist: 'artists', album: 'albums', playlist: 'playlists', radio: 'radio',
};

const icon = (path: ReactNode): ReactNode => path;

export const TAB_ICONS: Record<TabId, ReactNode> = {
  overview: icon(<svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7" /><path d="M6 10v10h12V10" /></svg>),
  albums: icon(<svg viewBox="0 0 24 24"><rect x="3" y="7" width="14" height="14" rx="1.5" /><path d="M7 3h14v14" /></svg>),
  artists: icon(<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>),
  liked: icon(<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-9.3-9.2C1.4 7.4 3.6 4 7 4c2.1 0 3.6 1.1 5 3 1.4-1.9 2.9-3 5-3 3.4 0 5.6 3.4 4.3 6.8C19.5 15.4 12 20 12 20Z" /></svg>),
  playlists: icon(<svg viewBox="0 0 24 24"><path d="M4 6h12M4 11h12M4 16h7M19 8v9" /><circle cx="16.5" cy="17" r="2.5" /></svg>),
  top: icon(<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" /></svg>),
  shows: icon(<svg viewBox="0 0 24 24"><path d="M4 8a2 2 0 0 0 0 4v4h16v-4a2 2 0 0 0 0-4V4H4z" /><path d="M14 4v12" strokeDasharray="2 2" /></svg>),
  upgrades: icon(<svg viewBox="0 0 24 24"><path d="M12 4v10M8 10l4 4 4-4" /><path d="M4 15v4h16v-4" /></svg>),
  cds: icon(<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" /><circle cx="12" cy="12" r="2.3" /><path d="M12 3.4a8.6 8.6 0 0 1 7.4 4.3" /></svg>),
  plays: icon(<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8" /><path d="M4 3v5h5" /><path d="m10 9 5 3-5 3z" /></svg>),
};
