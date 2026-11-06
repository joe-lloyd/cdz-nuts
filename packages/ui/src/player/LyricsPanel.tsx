import { useEffect, useRef, useState } from 'react';

import { player, usePlayer } from './usePlayer.ts';

export function LyricsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = usePlayer();
  const bodyRef = useRef<HTMLDivElement>(null);
  const lines = p.lyrics?.synced ?? null;

  // Keep the active line centred, unless the reader just scrolled themselves.
  useEffect(() => {
    if (!open || p.activeLine < 0 || !player.mayAutoscroll()) return;
    const body = bodyRef.current;
    const el = body?.querySelector<HTMLElement>(`[data-line="${p.activeLine}"]`);
    if (body && el) body.scrollTop = el.offsetTop - body.clientHeight * 0.4 + el.offsetHeight / 2;
  }, [open, p.activeLine]);

  const [timing, setTiming] = useState(false);
  // The kind of lyrics heads the panel; where they came from closes it.
  const [kind, ...from] = p.lyricsSource.split(' · ');
  return (
    <aside className="queue-panel lyrics-panel" aria-label="Lyrics" hidden={!open}>
      <div className="queue-head">
        <div><span>{kind}</span><b>{p.lyricsTitle}</b></div>
        {/* Timing is rarely needed, so on a phone it waits behind one button. */}
        <button className="timing-toggle" type="button" aria-label="Adjust sync" title="Adjust sync" aria-expanded={timing} onClick={() => setTiming(!timing)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="7" /><path d="M12 9v4l2 2M10 3h4" /></svg>
          <span className="timing-word">Adjust sync</span>
        </button>
        <div className={`lyrics-tools${timing ? ' open' : ''}`} role="group" aria-label="Lyrics timing">
          <small>Lyrics timing</small>
          <button type="button" aria-label="Shift lyrics half a second earlier" onClick={() => player.nudgeLyrics(-0.5)}>−0.5s</button>
          <span aria-live="polite">{`${p.lyricOffset > 0 ? '+' : ''}${p.lyricOffset.toFixed(1)}s`}</span>
          <button type="button" aria-label="Shift lyrics half a second later" onClick={() => player.nudgeLyrics(0.5)}>+0.5s</button>
          <button id="lyrics-close" type="button" aria-label="Close lyrics" onClick={onClose}>×</button>
        </div>
      </div>
      <div
        className="lyrics-body" ref={bodyRef}
        onWheel={() => player.markLyricsScrolled()}
        onTouchMove={() => player.markLyricsScrolled()}
        onPointerDown={() => player.markLyricsScrolled()}
      >
        {p.lyrics?.instrumental ? (
          <div className="empty">An instrumental — nothing to sing along to</div>
        ) : lines?.length ? lines.map((line, index) => (
          <button
            key={index}
            className={`lyric-line${index === p.activeLine ? ' on' : ''}`}
            type="button" data-line={index}
            onClick={() => player.seekTo(line.time + p.lyricOffset)}
          >
            {line.words?.length
              ? line.words.map((w, wi) => (
                  <span key={wi} className={`w${index === p.activeLine && wi <= p.activeWord ? ' sung' : ''}`}>{w.text}</span>
                ))
              : (line.text || '♪')}
          </button>
        )) : p.lyrics?.plain ? (
          <div className="lyrics-plain">{p.lyrics.plain}</div>
        ) : (
          <div className="empty">{p.lyrics ? 'No lyrics found for this track' : 'Play a track to follow its lyrics'}</div>
        )}
        {from.length ? <p className="lyrics-credit">Lyrics from {from.join(' · ')}</p> : null}
      </div>
    </aside>
  );
}
