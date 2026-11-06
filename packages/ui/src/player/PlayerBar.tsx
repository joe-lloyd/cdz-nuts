import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { formatTime } from '../lib/format.ts';
import { LyricsPanel } from './LyricsPanel.tsx';
import { QueuePanel } from './QueuePanel.tsx';
import { player, usePlayer } from './usePlayer.ts';
import { RadioControl } from '../components/primitives.tsx';
import { LikeButton } from '../components/LikeButton.tsx';
import { Slider } from './Slider.tsx';

/**
 * The bar, and the two panels that share its corner.
 *
 * Renders above the router outlet and never unmounts, which is what lets audio
 * survive navigation. It is a pure view onto the engine -- it holds no
 * playback state of its own, only which panel is open.
 */
export function PlayerBar() {
  const p = usePlayer();
  const [panel, setPanelState] = useState<'queue' | 'lyrics' | null>(null);
  // On a phone the bar rests compact and opens into a full now-playing view.
  const [expanded, setExpanded] = useState(false);
  const location = useLocation();
  useEffect(() => { setExpanded(false); }, [location.pathname]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [expanded]);
  // A panel opens over the page, so the full view steps back for it.
  const setPanel = (next: 'queue' | 'lyrics' | null) => { setExpanded(false); setPanelState(next); };

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.key !== ' ' || event.defaultPrevented || event.isComposing
        || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest(
        'input, textarea, select, button, a[href], summary, [contenteditable], [role="button"], [role="textbox"], [role="slider"]',
      )) return;
      event.preventDefault();
      if (!event.repeat && p.canPlay) player.toggle();
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [p.canPlay]);

  const current = p.queue[p.queueIndex];
  const artHref = p.albumId ? `/album/${encodeURIComponent(p.albumId)}` : null;
  // Null whenever the credit resolves to nobody we hold a page for -- a
  // library-only artist is still named, just not linked.
  const artistHref = p.artistId ? `/artist/${encodeURIComponent(p.artistId)}` : null;

  return (
    <>
      <section className={`player-bar${expanded ? ' expanded' : ''}`} id="player-bar" data-state={p.state} aria-label="Music player">
        <div className="player-sheet-head">
          <button className="player-collapse" type="button" aria-label="Close now playing" onClick={() => setExpanded(false)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          <span>Now playing</span>
        </div>
        <div className="player-track">
          {artHref ? (
            <Link className="player-art linked" to={artHref} tabIndex={-1} aria-hidden="true">
              <PlayerArt src={p.artUrl} fallback={p.artFallbackUrl} initial={p.initial} />
            </Link>
          ) : (
            <span className="player-art">
              <PlayerArt src={p.artUrl} fallback={p.artFallbackUrl} initial={p.initial} />
            </span>
          )}
          <div className="player-copy">
            <span className="player-overline">{p.overline}</span>
            <b>{p.title}</b>
            <span>
              {p.byline && artistHref
                ? <Link className="player-artist" to={artistHref}>{p.byline}</Link>
                : p.byline}
              {p.albumName && artHref ? (
                <>
                  {p.byline ? ' · ' : ''}
                  <Link className="player-album" to={artHref}>{p.albumName}</Link>
                </>
              ) : null}
            </span>
          </div>
          {p.radioSeedId && p.currentId === p.radioSeedId && current?.id === p.currentId
            ? <RadioControl track={{ id: p.radioSeedId, name: p.title, artists: current.artists, recording_mbid: current.recordingMbid ?? null }} /> : null}
          <button
            className="player-expand" type="button" aria-label="Open now playing" aria-expanded={expanded}
            disabled={!p.canPlay} onClick={() => setExpanded(true)}
          >
            {/* The visible sign that the bar opens. */}
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
          </button>
        </div>

        <div className="player-transport">
          <div className="player-controls">
            <button className="player-icon" type="button" aria-label="Previous track" disabled={!p.queue.length} onClick={() => player.previous()}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6zm3 7 9-7v14z" /></svg>
            </button>
            <button
              className="player-play" type="button" disabled={!p.canPlay}
              aria-label={p.state === 'playing' ? 'Pause' : 'Play'}
              onClick={() => player.toggle()}
            >
              <svg className="play-shape" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z" /></svg>
              <svg className="pause-shape" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z" /></svg>
            </button>
            <button className="player-icon" type="button" aria-label="Next track" disabled={!p.queue.length} onClick={() => void player.next()}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 5h2v14h-2zM6 5l9 7-9 7z" /></svg>
            </button>
          </div>
          <div className="scrubber-row">
            <span>{p.positionText}</span>
            <Slider
              value={p.progress}
              onValue={(fraction) => player.seekFraction(fraction)}
              label="Track position"
              disabled={!p.canScrub}
            />
            <span>{p.remainingText}</span>
          </div>
        </div>

        <div className="player-actions">
          {/* The full view is where a phone likes the song it is playing. */}
          {expanded && p.currentId ? <LikeButton track={{ id: p.currentId, name: p.title }} /> : null}
          <button
            className="queue-button lyrics-button" type="button" aria-label="Lyrics" title="Lyrics"
            aria-expanded={panel === 'lyrics'} disabled={!p.lyrics}
            onClick={() => setPanel(panel === 'lyrics' ? null : 'lyrics')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 7h4v4H6.5c0 2.2-.8 3.6-2 4.5M14 7h4v4h-2.5c0 2.2-.8 3.6-2 4.5" /><path d="M5 19h14" />
            </svg>
            <span className="button-label">Lyrics</span>
          </button>
          <button
            className="queue-button" type="button" aria-expanded={panel === 'queue'}
            aria-label={`Queue, ${p.queue.length} ${p.queue.length === 1 ? 'song' : 'songs'}`} title="Queue"
            onClick={() => setPanel(panel === 'queue' ? null : 'queue')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></svg>
            {p.queue.length ? <span className="count-badge" aria-hidden="true">{p.queue.length}</span> : null}
            <span className="button-label">Queue</span>
          </button>
          <label className="volume-control">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M11 5 6 9H2v6h4l5 4zM15 9a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12" />
            </svg>
            <Slider
              value={p.volumePosition}
              onValue={(position) => player.setVolumePosition(position)}
              label="Volume"
              steps={100}
            />
          </label>
        </div>
      </section>

      {/* Panels share the corner, so only one is ever open. */}
      <QueuePanel open={panel === 'queue'} onClose={() => setPanel(null)} />
      <LyricsPanel open={panel === 'lyrics'} onClose={() => setPanel(null)} />
    </>
  );
}

/** Art with the same two-step fallback the pages use: local, CDN, then letter. */
function PlayerArt({ src, fallback, initial }: { src: string; fallback: string; initial: string }) {
  const [stage, setStage] = useState<'primary' | 'cdn' | 'letter'>('primary');
  const url = stage === 'primary' ? src : stage === 'cdn' ? fallback : '';
  return (
    <>
      {url ? (
        <img
          id="player-art" src={url} alt=""
          onError={() => setStage(stage === 'primary' && fallback ? 'cdn' : 'letter')}
        />
      ) : null}
      <span id="player-art-fallback" style={url ? { display: 'none' } : undefined}>{initial}</span>
    </>
  );
}

export { formatTime };
