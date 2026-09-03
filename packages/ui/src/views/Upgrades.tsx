import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useUpgrades } from '../api/hooks.ts';
import { post } from '../api/client.ts';
import { until } from '../lib/format.ts';
import { Empty, Skeleton } from '../components/primitives.tsx';
import { player } from '../player/usePlayer.ts';
import type { UpgradeJob, UpgradeStatus } from '../api/types.ts';

const LABEL: Record<UpgradeStatus, string> = {
  pending_source: 'downloading source', queued: 'ready for upgrade', working: 'working now',
  retry_wait: 'retry scheduled', upgraded: 'upgraded', already_lossless: 'already lossless',
  exhausted: 'retries exhausted', cancelled: 'cancelled',
};
const ACTIVE: UpgradeStatus[] = ['pending_source', 'queued', 'working', 'retry_wait'];

export function Upgrades() {
  const { data, isPending, isFetching } = useUpgrades();
  const client = useQueryClient();
  const [mode, setMode] = useState('single');

  const refresh = () => void client.invalidateQueries({ queryKey: ['upgrades'] });

  const submit = useMutation({
    mutationFn: (values: Record<string, unknown>) => post('/api/upgrades', values),
    onSuccess: (_d, values) => {
      player.notify(values.sourceMode === 'single' ? 'Added to the archive and FLAC queue' : 'Album intake queued');
      refresh();
    },
    onError: (e: Error) => player.notify(e.message, true),
  });

  const act = useMutation({
    mutationFn: ({ action, id }: { action: string; id: number }) => post<{ removed?: number }>(`/api/upgrades/${action}`, { id }),
    onSuccess: (result, { action }) => {
      player.notify(action === 'retry' ? 'Retry queued now'
        : action === 'cancel' ? 'Upgrade cancelled'
        : `Removed ${result.removed ?? 0} entr${result.removed === 1 ? 'y' : 'ies'}`);
      refresh();
    },
    onError: (e: Error) => player.notify(e.message, true),
  });

  if (isPending) return <Skeleton />;
  const jobs = data?.jobs ?? [];
  const active = ACTIVE.reduce((n, k) => n + Number(data?.counts?.[k] ?? 0), 0);
  const finished = Number(data?.counts?.upgraded ?? 0) + Number(data?.counts?.already_lossless ?? 0);
  const batch = mode !== 'single';

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, unknown>;
    values.maxAttempts = Number(values.maxAttempts);
    submit.mutate(values);
  };

  return (
    <>
      <div className="upgrade-intro">
        <div>
          <span className="eyebrow">Lossy now, lossless later</span>
          <h2>Feed the archive today. Let FLAC catch up.</h2>
          <p>On the next worker sweep, a source link becomes an MP3; later sweeps replace it only after codec, duration, artist and title checks pass.</p>
        </div>
        <div className="upgrade-stats"><b>{active}</b><span>active</span><b>{finished}</b><span>finished</span></div>
      </div>

      <form className="upgrade-form" onSubmit={onSubmit}>
        <label>
          <span>Spotify or YouTube URL</span>
          <input name="sourceUrl" type="url" required placeholder={batch
            ? (mode === 'playlist' ? 'https://www.youtube.com/playlist?list=...' : 'https://youtu.be/...')
            : 'https://open.spotify.com/track/...'} />
        </label>
        <label>
          <span>Source type</span>
          <select name="sourceMode" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="single">Single track</option>
            <option value="playlist">YouTube playlist</option>
            <option value="chapters">Chaptered video</option>
          </select>
        </label>
        <label><span>Artist <small>(needed for YouTube)</small></span><input name="artist" placeholder="Artist" required={batch} /></label>
        <label><span>Title <small>(single track)</small></span><input name="title" placeholder="Song title" disabled={batch} /></label>
        <label><span>Album <small>(required for album intake)</small></span><input name="album" placeholder="Album" required={batch} /></label>
        <label><span>FLAC attempts</span><input name="maxAttempts" type="number" min={1} max={20} defaultValue={6} /></label>
        <button className="primary-action" type="submit" disabled={submit.isPending}>
          {batch ? 'Import album + queue every track for FLAC' : 'Add to archive + FLAC queue'}
        </button>
      </form>

      <h2>Upgrade queue {isFetching ? <i className="spin" /> : null}</h2>
      <div className="upgrade-list">
        {jobs.length
          ? jobs.map((job) => <Card key={job.id} job={job} onAct={(action) => act.mutate({ action, id: job.id })} />)
          : <Empty>nothing queued yet</Empty>}
      </div>
    </>
  );
}

function Card({ job, onAct }: { job: UpgradeJob; onAct: (action: string) => void }) {
  const batch = job.source_mode && job.source_mode !== 'single';
  const label = batch && job.status === 'upgraded' ? 'album imported' : LABEL[job.status] ?? job.status;
  const due = job.next_attempt_at && (['retry_wait', 'queued', 'pending_source'] as string[]).includes(job.status)
    ? `${job.status === 'retry_wait' ? 'retry ' : ''}${until(job.next_attempt_at)}` : '';
  const attempts = job.phase === 'source'
    ? { used: job.source_attempts, max: 3, what: 'source' }
    : { used: job.upgrade_attempts, max: job.max_attempts, what: 'FLAC' };

  const canRetry = (['retry_wait', 'exhausted', 'cancelled'] as string[]).includes(job.status);
  const canCancel = (['pending_source', 'queued', 'retry_wait'] as string[]).includes(job.status);
  const canRemove = (['upgraded', 'already_lossless', 'exhausted', 'cancelled'] as string[]).includes(job.status);

  const detail = batch && job.status === 'upgraded'
    ? `${job.batch_size ?? 0} tracks imported and queued for FLAC`
    : [job.track_number ? `track ${job.track_number}` : '', batch ? job.source_mode : '', due].filter(Boolean).join(' · ');

  return (
    <div className={`upgrade-card is-${job.status}`}>
      <div className="upgrade-head">
        <span className={`upgrade-state ${job.status}`}>
          {job.status === 'working' ? <i className="spin" /> : null}{label}
        </span>
        {job.current_codec ? (
          <span className={`q-badge ${job.current_codec === 'flac' ? 'q-lossless' : 'q-standard'}`}>
            <b>{job.current_codec.toUpperCase()}</b>
          </span>
        ) : null}
      </div>
      <b className="upgrade-title">{job.title}</b>
      <span className="upgrade-sub">{job.artist}{job.album ? ` · ${job.album}` : ''}</span>
      <div>
        {/* The attempt budget as dots: spent, glowing when live, still available. */}
        <span className="upgrade-dots">
          {Array.from({ length: attempts.max }, (_, i) => (
            <i key={i} className={`${i < attempts.used ? 'used' : ''}${job.status === 'working' && i === attempts.used ? ' live' : ''}`.trim() || undefined} />
          ))}
        </span>
        <small>{attempts.used}/{attempts.max} {attempts.what}{detail ? ` · ${detail}` : ''}</small>
      </div>
      {job.last_error ? <em className="upgrade-error">{job.last_error}</em> : null}
      {canRetry || canCancel || canRemove ? (
        <div className="upgrade-actions">
          {canRetry ? <button type="button" onClick={() => onAct('retry')}>Retry now</button> : null}
          {canCancel ? <button type="button" onClick={() => onAct('cancel')}>Cancel</button> : null}
          {canRemove ? (
            <button type="button" className="danger" onClick={() => {
              // Removing forgets the queue entry; the audio files stay on disk.
              if (confirm('Remove this from the queue and the library listing? The downloaded files stay on disk.')) onAct('delete');
            }}>Remove</button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
