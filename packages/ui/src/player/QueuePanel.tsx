import { RadioControl } from '../components/primitives.tsx';
import { formatTime, initial as letterFor } from '../lib/format.ts';
import { artUrlFor } from './engine.ts';
import { player, usePlayer } from './usePlayer.ts';

export function QueuePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = usePlayer();
  return (
    <aside className="queue-panel" aria-label="Play queue" hidden={!open}>
      <div className="queue-head">
        <div><span>{p.queue.length} {p.queue.length === 1 ? 'song' : 'songs'}</span><b>Your queue</b></div>
        <button type="button" aria-label="Close queue" onClick={onClose}>×</button>
      </div>
      <div className="queue-list">
        {p.queue.length ? p.queue.map((item, index) => (
          <div className="queue-entry" key={`${item.id}-${index}`}>
            <button
              className={`queue-item${index === p.queueIndex ? ' on' : ''}`}
              type="button"
              onClick={() => void player.playAt(index)}
            >
              {index === p.queueIndex
                ? <span className="queue-index now" aria-label="Now playing"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 20V10M12 20V4M18 20v-7" /></svg></span>
                : <span className="queue-index">{index + 1}</span>}
              <span className="queue-art">
                <i>{letterFor(item.name)}</i>
                {item.albumId || item.imageUrl ? (
                  // The letter stays underneath for an album with no cover.
                  <img
                    src={item.albumId ? artUrlFor(item.albumId) : item.imageUrl} alt="" loading="lazy"
                    onError={(e) => { e.currentTarget.hidden = true; }}
                  />
                ) : null}
              </span>
              <span>
                <b>{item.name || 'Unknown track'}</b>
                <small>{item.artists}</small>
              </span>
              <span className="queue-duration">{formatTime((item.durationMs ?? 0) / 1000)}</span>
            </button>
            <RadioControl track={{ id: item.id, name: item.name, artists: item.artists, recording_mbid: item.recordingMbid ?? null }} />
          </div>
        )) : <div className="empty">Your queue is empty</div>}
      </div>
    </aside>
  );
}
