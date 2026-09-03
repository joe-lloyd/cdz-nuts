// The URL space, in one place.
//
// This is the list the server-side fallbacks are really about: music-dump and
// the Tauri shell both have to answer "is this a client route or a 404?", and
// neither can import TypeScript. They answer it by exclusion instead -- anything
// that is not an API path and not a known asset is handed to the app -- so this
// table is documentation and router config, not a shared contract. Keep it
// honest anyway; it is the only written record of what the app answers to.

import type { ReactNode } from 'react';

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

/** The eyebrow and heading each tab shows in the page head. */
export const PAGE_COPY: Record<TabId, [string, string]> = {
  overview: ['Your listening memory', 'The collection'],
  radio: ['Everything you have not heard yet', 'Radio'],
  latest: ['Freshly on disk', 'Latest downloads'],
  artists: ['Everyone in your orbit', 'Artists'],
  liked: ['Saved, remembered, searchable', 'Songs'],
  albums: ['The record shelf', 'Albums'],
  playlists: ['Your hand-built paths', 'Playlists'],
  top: ['Listening, counted honestly', 'Your top music'],
  shows: ['Artists leaving the speakers', 'Upcoming shows'],
  cds: ['The discs on the shelf', 'CD collection'],
  upgrades: ['Lossless, eventually', 'FLAC upgrade queue'],
  plays: ['The latest signals', 'Recently played'],
};

export const DETAIL_COPY = {
  artist: ['Artist in your archive', 'Artist'],
  album: ['Release in your archive', 'Album'],
  playlist: ['A hand-built path', 'Playlist'],
} as const;

/** Where a sub page goes back to when there is no history of ours behind us. */
export const PARENT_OF: Record<string, string> = {
  artist: 'artists', album: 'albums', playlist: 'playlists', radio: 'radio',
};

const icon = (path: ReactNode): ReactNode => path;

export const TAB_ICONS: Record<TabId, ReactNode> = {
  overview: icon(<svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z" /></svg>),
  artists: icon(<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>),
  liked: icon(<svg viewBox="0 0 24 24"><path d="M9 18V5l10-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></svg>),
  albums: icon(<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2" /><path d="M12 3v3" /></svg>),
  playlists: icon(<svg viewBox="0 0 24 24"><path d="M4 6h11M4 11h11M4 16h7M18 14v6m-3-3h6" /></svg>),
  latest: icon(<svg viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" /><circle cx="12" cy="12" r="9" /></svg>),
  radio: icon(<svg viewBox="0 0 24 24"><circle cx="12" cy="14" r="3" /><path d="M5.6 8.4a9 9 0 0 1 12.8 0M8.5 11.3a5 5 0 0 1 7 0" /></svg>),
  top: icon(<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" /></svg>),
  shows: icon(<svg viewBox="0 0 24 24"><path d="M6 3v18M18 3v18M6 7h12M6 17h12" /><path d="M10 11h4v2h-4z" /></svg>),
  upgrades: icon(<svg viewBox="0 0 24 24"><path d="M4 17h3l2-10 3 13 3-9 2 6h3" /><path d="m16 6 2-2 2 2M18 4v6" /></svg>),
  cds: icon(<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" /><circle cx="12" cy="12" r="2.3" /><path d="M12 3.4a8.6 8.6 0 0 1 7.4 4.3" /></svg>),
  plays: icon(<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8" /><path d="M4 3v5h5" /><path d="m10 9 5 3-5 3z" /></svg>),
};
