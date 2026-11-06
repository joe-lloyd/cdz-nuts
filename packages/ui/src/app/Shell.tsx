import { GlobalSearch } from './GlobalSearch.tsx';
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useListenBrainz, usePlayerStatus, useStats } from '../api/hooks.ts';
import { RadioEnabled } from '../components/primitives.tsx';
import { ago } from '../lib/format.ts';
import { PlayerBar } from '../player/PlayerBar.tsx';
import { player, usePlayer } from '../player/usePlayer.ts';
import { TABS, TAB_ICONS, PAGE_COPY, ASIDE_COPY, DETAIL_COPY, NOT_FOUND_COPY, PARENT_OF, SETTINGS_ICON, type TabId } from './routes.tsx';
import { useDesktop } from '../api/hooks.ts';

/**
 * The frame everything renders inside.
 *
 * The player bar lives here, above the router outlet, and is never unmounted --
 * that is what lets audio survive navigation. Only <Outlet /> changes.
 */
/** A detail page keeps its list's menu item lit, so you know where you are. */
const parentTab = (path: string): string | undefined => PARENT_OF[path.split('/')[1] ?? ''];

export function Shell() {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the drawer on navigation; leaving it open over the new page is the
  // kind of thing that only shows up on a phone.
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  useEffect(() => {
    document.body.classList.toggle('nav-open', drawerOpen);
    return () => document.body.classList.remove('nav-open');
  }, [drawerOpen]);

  const { kicker, title, parent, detail } = describe(location.pathname);
  // Unknown until it answers, so links show rather than flicker in.
  const radio = useListenBrainz();

  return (
    <RadioEnabled value={radio.data?.enabled ?? true}>
      <div className="loader" aria-hidden="true" />
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="mobile-bar">
        <button
          className="burger" type="button" aria-expanded={drawerOpen}
          aria-label={drawerOpen ? 'Close menu' : 'Open menu'} aria-controls="nav-drawer"
          onClick={() => setDrawerOpen((v) => !v)}
        >
          <span /><span /><span />
        </button>
        <Link className="brand-mini" to="/overview">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <b>cdz-nutz</b>
        </Link>
        <BackButton parent={parent} className="page-back top-back" />
        <button
          className="search-toggle" type="button" aria-label="Search"
          onClick={() => {
            document.body.classList.add('search-open');
            document.querySelector<HTMLInputElement>('input[aria-label="Search music"]')?.focus();
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
        </button>
      </header>

      <div className="nav-backdrop" hidden={!drawerOpen} onClick={() => setDrawerOpen(false)} />

      <div className="app-shell">
        <aside className="sidebar" id="nav-drawer">
          <header className="brand-head">
            <Link className="brand" to="/overview" aria-label="cdz-nutz home">
              <span className="brand-mark" aria-hidden="true"><span /></span>
              <span><b>cdz-nutz</b><small>Private archive</small></span>
            </Link>
            <button className="drawer-close" type="button" aria-label="Close menu" onClick={() => setDrawerOpen(false)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </header>
          <nav id="nav" aria-label="Library">
            {(Object.keys(TABS) as TabId[]).map((tab) => (
              <NavLink key={tab} to={`/${tab}`} className={({ isActive }) => (isActive || parentTab(location.pathname) === tab ? 'on' : undefined)}>
                {TAB_ICONS[tab]}
                <span>{TABS[tab]}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-foot">
            <ArchiveState />
            <SyncLine />
            <div className="foot-row">
              <NavLink to="/settings" className={({ isActive }) => (isActive ? 'on' : undefined)}>
                {SETTINGS_ICON}
                <span>About</span>
                <VersionChip />
              </NavLink>
            </div>
          </div>
        </aside>

        <section className="content-shell">
          <GlobalSearch>
          <header className={`page-head${detail ? ' is-detail' : ''}`}>
            <div>
              <BackButton parent={parent} className="page-back" />
              <span className="page-kicker">{kicker}</span>
              {detail ? null : <h1>{title}</h1>}
            </div>
            <div className="page-head-tools">
              <ReconnectButton />
            </div>
          </header>
          <main id="main" tabIndex={-1}><Outlet /></main>
          </GlobalSearch>
        </section>
      </div>

      <PlayerBar />
      <Toast />
    </RadioEnabled>
  );
}

/**
 * Which build you are looking at, in the one place you always see.
 *
 * The desktop app has a version number that can fall behind, so it gets one.
 * A browser is always on whatever the server just served, so it shows
 * nothing here; its front-end build id is on the Settings page.
 */
export function VersionChip() {
  const { data: desktop } = useDesktop();

  if (desktop) {
    return (
      <span
        className={`version-chip${desktop.update_pending ? ' has-update' : ''}`}
        title={desktop.update_pending
          ? 'An update is downloaded and waiting. Install it from Settings.'
          : 'The version of the desktop app you are running'}
      >
        v{desktop.version}
      </span>
    );
  }
  return null;
}

/** What the page head says, derived from the path rather than set by each view. */
function describe(pathname: string): { kicker: string; title: string; parent: string | null; detail: boolean } {
  const [, head, ...rest] = pathname.split('/');
  if (head === 'radio' && rest.length >= 2) {
    return { kicker: 'Something you have not heard yet', title: 'Radio', parent: 'radio', detail: false };
  }
  // A detail page names its artist, album or playlist in its own hero, so the
  // head carries only the kicker and the way back.
  if (head && head in DETAIL_COPY && rest.length) {
    const copy = DETAIL_COPY[head as keyof typeof DETAIL_COPY];
    return { kicker: copy[0], title: copy[1], parent: PARENT_OF[head] ?? null, detail: true };
  }
  const aside = head ? ASIDE_COPY[head] : undefined;
  if (aside) return { kicker: aside[0], title: aside[1], parent: null, detail: false };
  // The logo and the bare root land on the overview.
  if (!head) return { kicker: PAGE_COPY.overview![0], title: PAGE_COPY.overview![1], parent: null, detail: false };
  const copy = PAGE_COPY[head] ?? NOT_FOUND_COPY;
  return { kicker: copy[0], title: copy[1], parent: null, detail: false };
}

/**
 * Back, without leaving the app.
 *
 * The app is normally opened inside the phone's WebView, which has no browser
 * chrome, so the system back gesture closes the whole thing rather than
 * stepping back a page. History is only safe to pop once this document has put
 * an entry behind us -- on a cold deep link there is nothing of ours to go
 * back to, so the button goes to the list the page belongs to instead.
 */
function BackButton({ parent, className }: { parent: string | null; className: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const canPop = (location.key ?? 'default') !== 'default';
  if (!parent) return null;
  return (
    <button
      className={className} type="button"
      aria-label={canPop ? 'Back' : `Back to ${TABS[parent as TabId] ?? parent}`}
      onClick={() => (canPop ? navigate(-1) : navigate(`/${parent}`))}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
      <span>Back</span>
    </button>
  );
}

/** The quiet monospace line under the archive state: when Spotify last synced. */
function SyncLine() {
  const { data } = useStats();
  const syncedAt = typeof data?.syncedAt === 'string' ? data.syncedAt : null;
  return <div id="sync">{syncedAt ? `last sync ${ago(syncedAt)}` : ''}</div>;
}

function ArchiveState() {
  const { data } = usePlayerStatus();
  const state = data?.state ?? 'checking';
  const label = state === 'ready' ? 'Archive ready'
    : state === 'archive-offline' ? 'Archive asleep'
    : state === 'unconfigured' ? 'Playback setup pending'
    : state === 'checking' ? 'Checking archive'
    : 'Jellyfin unavailable';
  return (
    <div className="archive-state" data-state={state}>
      <span className="state-dot" aria-hidden="true" />
      <span><b>{label}</b><small>{(data?.detail ?? 'Jellyfin connection').replace(/ ready$/, '')}</small></span>
    </div>
  );
}

export function ReconnectButton() {
  const { data: desktop } = useDesktop();
  const { data, isError, isPending, refetch } = usePlayerStatus();
  const p = usePlayer();
  const [reconnecting, setReconnecting] = useState(false);
  const offer = Boolean(desktop && (
    isError || (!isPending && data?.state !== 'ready') || p.canReconnect
  ));
  if (!offer) return null;
  return (
    <button
      className="wake-button" type="button" disabled={reconnecting}
      onClick={() => {
        setReconnecting(true);
        void player.reconnect()
          .then(() => refetch())
          .finally(() => setReconnecting(false));
      }}
    >
      {reconnecting ? 'Reconnecting…' : 'Reconnect'}
    </button>
  );
}

function Toast() {
  const { toast } = usePlayer();
  return (
    <div className={`toast${toast ? ' on' : ''}${toast?.bad ? ' bad' : ''}`} role="status" aria-live="polite">
      {toast?.message ?? ''}
    </div>
  );
}
