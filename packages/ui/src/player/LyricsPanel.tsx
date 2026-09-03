import { useEffect, useRef } from 'react';

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
    if (body && el) body.scrollTop = el.offsetTop - body.clientHeight / 2 + el.offsetHeight / 2;
  }, [open, p.activeLine]);

  return (
    <aside className="queue-panel lyrics-panel" aria-label="Lyrics" hidden={!open}>
      <div className="queue-head">
        <div><span>{p.lyricsSource}</span><b>{p.lyricsTitle}</b></div>
        <div className="lyrics-tools">
          <button type="button" aria-label="Shift lyrics half a second earlier" onClick={() => player.nudgeLyrics(-0.5)}>−.5s</button>
          <span aria-live="polite">{`${p.lyricOffset > 0 ? '+' : ''}${p.lyricOffset.toFixed(1)}s`}</span>
          <button type="button" aria-label="Shift lyrics half a second later" onClick={() => player.nudgeLyrics(0.5)}>+.5s</button>
          <button type="button" aria-label="Close lyrics" onClick={onClose}>×</button>
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
      </div>
    </aside>
  );
}
