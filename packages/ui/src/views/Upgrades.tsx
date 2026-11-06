import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useUpgrades } from '../api/hooks.ts';
import { post } from '../api/client.ts';
import { until } from '../lib/format.ts';
import { Empty, Skeleton } from '../components/primitives.tsx';
import { player } from '../player/usePlayer.ts';
import type { UpgradeJob, UpgradeStatus } from '../api/types.ts';

const LABEL: Record<UpgradeStatus, string> = {
  pending_source: 'Waiting to download', queued: 'MP3 in, waiting for FLAC', working: 'Working on it now',
  retry_wait: 'Will try again', upgraded: 'Lossless now', already_lossless: 'Already lossless',
  exhausted: 'Gave up', cancelled: 'Cancelled',
};
const ACTIVE: UpgradeStatus[] = ['pending_source', 'queued', 'working', 'retry_wait'];

export function Upgrades() {
  const { data, isPending, isFetching } = useUpgrades();
  const client = useQueryClient();
  const [mode, setMode] = useState('single');
  const [more, setMore] = useState(false);
  const [adding, setAdding] = useState(false);
  const [needle, setNeedle] = useState('');
  const [show, setShow] = useState<'all' | 'active' | 'done' | 'stopped'>('all');

  const refresh = () => void client.invalidateQueries({ queryKey: ['upgrades'] });

  const submit = useMutation({
    mutationFn: (values: Record<string, unknown>) => post('/api/upgrades', values),
    onSuccess: (_d, values) => {
      player.notify(values.sourceMode === 'single' ? 'Requested; it joins the archive soon' : 'Album requested');
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

  if (isPending) return <Skeleton label="Loading requests…" />;
  const jobs = data?.jobs ?? [];
  const active = ACTIVE.reduce((n, k) => n + Number(data?.counts?.[k] ?? 0), 0);
  const finished = Number(data?.counts?.upgraded ?? 0) + Number(data?.counts?.already_lossless ?? 0);
  const batch = mode !== 'single';
  const term = needle.trim().toLowerCase();
  const shown = jobs.filter((job) =>
    (show === 'all' || (show === 'active' ? ACTIVE.includes(job.status)
      : show === 'done' ? job.status === 'upgraded' || job.status === 'already_lossless'
      : job.status === 'exhausted' || job.status === 'cancelled'))
    && (!term || `${job.title} ${job.artist} ${job.album ?? ''}`.toLowerCase().includes(term)));

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, unknown>;
    values.maxAttempts = Number(values.maxAttempts);
    submit.mutate(values);
  };

  return (
    <>
      <div className="upgrade-intro">
        <p>Paste a link and the song joins the archive as an MP3 within a few minutes. The server then keeps looking for a lossless copy and swaps it in when one matches.</p>
        <div className="upgrade-stats"><span><b>{active}</b> in progress</span><span><b>{finished}</b> finished</span></div>
      </div>

      {/* On a phone the queue comes first; the form opens when asked for. */}
      <button className="primary-action upgrade-add" type="button" aria-expanded={adding} onClick={() => setAdding(!adding)}>
        {adding ? 'Close the form' : 'Request a song'}
      </button>
      <form className={`upgrade-form${adding ? ' open' : ''}`} onSubmit={onSubmit}>
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
        {/* The optional fields fold away until asked for, so the link and
            its button lead. Album imports need them, so those open them. */}
        <button className="upgrade-more" type="button" aria-expanded={more || batch} onClick={() => setMore(!more)} hidden={batch}>
          {more ? 'Hide matching details' : 'Help it match (optional)'}
        </button>
        <label className={`upgrade-extra${more || batch ? ' open' : ''}`}><span>Artist</span><input name="artist" placeholder="Artist" required={batch} /><small>{batch ? 'Required' : 'Optional; helps match a YouTube link'}</small></label>
        {batch ? null : <label className={`upgrade-extra${more ? ' open' : ''}`}><span>Title</span><input name="title" placeholder="Song title" /><small>Optional</small></label>}
        <label className={`upgrade-extra${more || batch ? ' open' : ''}`}><span>Album</span><input name="album" placeholder="Album" required={batch} /><small>{batch ? 'Required' : 'Optional'}</small></label>
        <label className={`upgrade-extra${more || batch ? ' open' : ''}`}><span>Give up after</span><input name="maxAttempts" type="number" min={1} max={20} defaultValue={6} aria-describedby="give-up-unit" /><small id="give-up-unit">searches for a lossless copy</small></label>
        <button className="primary-action" type="submit" disabled={submit.isPending}>
          {batch ? 'Import the album' : 'Request the song'}
        </button>
      </form>

      <h2>Request queue <span className="count">{jobs.length}</span> {isFetching ? <i className="spin" /> : null}</h2>
      {/* A queue of a hundred or more is found by name or narrowed by state. */}
      <div className="tools queue-tools">
        <input type="search" aria-label="Find a request" placeholder="Find a request" value={needle} onChange={(e) => setNeedle(e.target.value)} />
        <div className="seg" role="group" aria-label="Show">
          {([['all', 'All'], ['active', 'In progress'], ['done', 'Finished'], ['stopped', 'Stopped']] as const).map(([key, label]) => (
            <button key={key} type="button" className={show === key ? 'on' : undefined} aria-pressed={show === key} onClick={() => setShow(key)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="upgrade-list">
        {shown.length
          ? shown.map((job) => <Card key={job.id} job={job} onAct={(action) => act.mutate({ action, id: job.id })} />)
          : <Empty>{jobs.length ? 'No request matches' : 'Nothing requested yet'}</Empty>}
      </div>
    </>
  );
}

function Card({ job, onAct }: { job: UpgradeJob; onAct: (action: string) => void }) {
  const batch = job.source_mode && job.source_mode !== 'single';
  const label = batch && job.status === 'upgraded' ? 'album imported' : LABEL[job.status] ?? job.status;
  const due = job.next_attempt_at && (['retry_wait', 'queued', 'pending_source'] as string[]).includes(job.status)
    && !until(job.next_attempt_at).includes('due now')
    // "Next attempt now" on every waiting card says nothing; only a later time does.
    ? `next attempt ${until(job.next_attempt_at)}` : '';
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
        <small>{attempts.used} of {attempts.max} {attempts.what === 'FLAC' ? 'lossless' : 'download'} tries used{detail ? ` · ${detail}` : ''}</small>
      </div>
      {job.last_error ? <em className="upgrade-error">{job.last_error}</em> : null}
      {canRetry || canCancel || canRemove ? (
        <div className="upgrade-actions">
          {canRetry ? <button type="button" onClick={() => onAct('retry')}>Retry now</button> : null}
          {canCancel ? <button type="button" className="quiet" onClick={() => { if (confirm(`Stop looking for ${job.title}?`)) onAct('cancel'); }}>Cancel request</button> : null}
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
