import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { usePlayerStatus, useStats } from '../api/hooks.ts';
import { ago } from '../lib/format.ts';
import { PlayerBar } from '../player/PlayerBar.tsx';
import { player, usePlayer } from '../player/usePlayer.ts';
import { TABS, TAB_ICONS, PAGE_COPY, DETAIL_COPY, PARENT_OF, type TabId } from './routes.tsx';

/**
 * The frame everything renders inside.
 *
 * The player bar lives here, above the router outlet, and is never unmounted --
 * that is what lets audio survive navigation. Only <Outlet /> changes.
 */
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

  const { kicker, title, parent } = describe(location.pathname);

  return (
    <>
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
          <b>Music Taste</b>
        </Link>
        <BackButton parent={parent} className="page-back top-back" />
      </header>

      <div className="nav-backdrop" hidden={!drawerOpen} onClick={() => setDrawerOpen(false)} />

      <div className="app-shell">
        <aside className="sidebar" id="nav-drawer">
          <header className="brand-head">
            <Link className="brand" to="/overview" aria-label="Music Taste home">
              <span className="brand-mark" aria-hidden="true"><span /></span>
              <span><b>Music Taste</b><small>Private archive</small></span>
            </Link>
          </header>
          <nav id="nav" aria-label="Library">
            {(Object.keys(TABS) as TabId[]).map((tab) => (
              <NavLink key={tab} to={`/${tab}`} className={({ isActive }) => (isActive ? 'on' : undefined)}>
                {TAB_ICONS[tab]}
                <span>{TABS[tab]}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-foot"><ArchiveState /><SyncLine /></div>
        </aside>

        <section className="content-shell">
          <header className="page-head">
            <div>
              <BackButton parent={parent} className="page-back" />
              <span className="page-kicker">{kicker}</span>
              <h1>{title}</h1>
            </div>
            <WakeButton />
          </header>
          <main id="main" tabIndex={-1}><Outlet /></main>
        </section>
      </div>

      <PlayerBar />
      <Toast />
    </>
  );
}

/** What the page head says, derived from the path rather than set by each view. */
function describe(pathname: string): { kicker: string; title: string; parent: string | null } {
  const [, head, ...rest] = pathname.split('/');
  if (head === 'radio' && rest.length >= 2) {
    return { kicker: 'Something you have not heard yet', title: 'Radio', parent: 'radio' };
  }
  if (head && head in DETAIL_COPY && rest.length) {
    const copy = DETAIL_COPY[head as keyof typeof DETAIL_COPY];
    return { kicker: copy[0], title: copy[1], parent: PARENT_OF[head] ?? null };
  }
  const tab = (head && head in TABS ? head : 'overview') as TabId;
  const copy = PAGE_COPY[tab];
  return { kicker: copy[0], title: copy[1], parent: null };
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
      <span><b>{label}</b><small>{data?.detail ?? 'Jellyfin connection'}</small></span>
    </div>
  );
}

function WakeButton() {
  const { data } = usePlayerStatus();
  const p = usePlayer();
  const [waking, setWaking] = useState(false);
  const offer = (data?.wakeAvailable && data.state === 'archive-offline') || p.wakeAvailable;
  if (!offer) return null;
  return (
    <button
      className="wake-button" type="button" disabled={waking}
      onClick={() => { setWaking(true); void player.wake().finally(() => setWaking(false)); }}
    >
      {waking ? 'Waking eliot…' : 'Wake eliot'}
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
