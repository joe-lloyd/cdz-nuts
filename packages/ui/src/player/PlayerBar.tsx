import { useState } from 'react';
import { Link } from 'react-router-dom';

import { formatTime } from '../lib/format.ts';
import { LyricsPanel } from './LyricsPanel.tsx';
import { QueuePanel } from './QueuePanel.tsx';
import { player, usePlayer } from './usePlayer.ts';

/**
 * The bar, and the two panels that share its corner.
 *
 * Renders above the router outlet and never unmounts, which is what lets audio
 * survive navigation. It is a pure view onto the engine -- it holds no
 * playback state of its own, only which panel is open.
 */
export function PlayerBar() {
  const p = usePlayer();
  const [panel, setPanel] = useState<'queue' | 'lyrics' | null>(null);

  const artHref = p.albumId ? `/album/${encodeURIComponent(p.albumId)}` : null;

  return (
    <>
      <section className="player-bar" id="player-bar" data-state={p.state} aria-label="Music player">
        <div className="player-track">
          {artHref ? (
            <Link className="player-art linked" to={artHref}>
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
              {p.byline}
              {p.albumName && artHref ? (
                <>
                  {p.byline ? ' · ' : ''}
                  <Link className="player-album" to={artHref}>{p.albumName}</Link>
                </>
              ) : null}
            </span>
          </div>
          {/* The most natural moment to want more like this is while it plays.
              Only a library track has a recording id to seed a station with. */}
          {p.radioSeedId ? (
            <Link
              className="player-radio"
              to={`/radio/track/${encodeURIComponent(p.radioSeedId)}`}
              aria-label="Radio from this song"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="14" r="2.6" />
                <path d="M6.1 8.6a8.4 8.4 0 0 1 11.8 0M8.9 11.4a4.5 4.5 0 0 1 6.2 0" />
              </svg>
            </Link>
          ) : null}
        </div>

        <div className="player-transport">
          <div className="player-controls">
            <button className="player-icon" type="button" aria-label="Previous track" onClick={() => player.previous()}>
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
            <button className="player-icon" type="button" aria-label="Next track" onClick={() => void player.next()}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 5h2v14h-2zM6 5l9 7-9 7z" /></svg>
            </button>
          </div>
          <div className="scrubber-row">
            <span>{p.positionText}</span>
            <input
              type="range" min={0} max={1000} disabled={!p.canScrub}
              value={Math.round(p.progress * 1000)} aria-label="Track position"
              onChange={(e) => player.seekFraction(Number(e.target.value) / 1000)}
            />
            <span>{p.remainingText}</span>
          </div>
        </div>

        <div className="player-actions">
          <button
            className="queue-button lyrics-button" type="button" aria-label="Lyrics"
            aria-expanded={panel === 'lyrics'} disabled={!p.lyrics}
            onClick={() => setPanel(panel === 'lyrics' ? null : 'lyrics')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 18V6l10-2v11" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="15" r="2.5" />
            </svg>
          </button>
          <button
            className="queue-button" type="button" aria-expanded={panel === 'queue'}
            onClick={() => setPanel(panel === 'queue' ? null : 'queue')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h12M4 11h12M4 16h8M18 14v6m-3-3h6" /></svg>
            <span>{p.queue.length}</span>
          </button>
          <label className="volume-control">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M11 5 6 9H2v6h4l5 4zM15 9a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12" />
            </svg>
            <input
              type="range" min={0} max={1} step={0.01} value={p.volumePosition}
              aria-label="Volume" onChange={(e) => player.setVolumePosition(Number(e.target.value))}
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
