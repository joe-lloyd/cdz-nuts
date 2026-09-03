import { formatTime, initial as letterFor } from '../lib/format.ts';
import { player, usePlayer } from './usePlayer.ts';

export function QueuePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = usePlayer();
  return (
    <aside className="queue-panel" aria-label="Play queue" hidden={!open}>
      <div className="queue-head">
        <div><span>Next up</span><b>Your queue</b></div>
        <button type="button" aria-label="Close queue" onClick={onClose}>×</button>
      </div>
      <div className="queue-list">
        {p.queue.length ? p.queue.map((item, index) => (
          <button
            key={`${item.id}-${index}`}
            className={`queue-item${index === p.queueIndex ? ' on' : ''}`}
            type="button"
            onClick={() => void player.playAt(index)}
          >
            <span className="queue-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="queue-art">
              <i>{letterFor(item.name)}</i>
            </span>
            <span>
              <b>{item.name || 'Unknown track'}</b>
              <small>{item.artists}</small>
            </span>
            <span className="queue-duration">{formatTime((item.durationMs ?? 0) / 1000)}</span>
          </button>
        )) : <div className="empty">Your queue is empty</div>}
      </div>
    </aside>
  );
}
