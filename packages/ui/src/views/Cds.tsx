import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useCds } from '../api/hooks.ts';
import { post } from '../api/client.ts';
import { day, initial } from '../lib/format.ts';
import { Empty, Skeleton } from '../components/primitives.tsx';
import { player } from '../player/usePlayer.ts';
import type { CdItem } from '../api/types.ts';

const STATUS_LABEL: Record<CdItem['status'], string> = {
  shelf: 'To rip', ripping: 'Ripping', ripped: 'Ripped', skip: 'Skipped',
};
// Ordered so the button always offers the next sensible step; skip is the
// escape hatch and lives on its own control.
const NEXT: Record<CdItem['status'], CdItem['status']> = {
  shelf: 'ripping', ripping: 'ripped', ripped: 'shelf', skip: 'shelf',
};
const FILTERS: Array<[string, string]> = [
  ['shelf', 'To rip'], ['ripping', 'Ripping'], ['ripped', 'Ripped'], ['skip', 'Skipped'], ['all', 'All'],
];

export function Cds() {
  const { data, isPending } = useCds();
  const client = useQueryClient();
  const [filter, setFilter] = useState('shelf');
  const [q, setQ] = useState('');

  const refresh = () => void client.invalidateQueries({ queryKey: ['cds'] });

  const setStatus = useMutation({
    mutationFn: (vars: { releaseId: number; status: string }) => post('/api/cds/status', vars),
    onSuccess: refresh,
    onError: (e: Error) => player.notify(e.message, true),
  });

  const sync = useMutation({
    mutationFn: () => post<{ added: number; updated: number; removed: number; reconciled: number }>('/api/cds/sync', {}),
    onSuccess: (d) => {
      player.notify(`${d.added} new, ${d.updated} refreshed, ${d.removed} gone, ${d.reconciled} already ripped`);
      refresh();
    },
    onError: (e: Error) => player.notify(e.message, true),
  });

  if (isPending) return <Skeleton />;
  const d = data!;

  if (!d.canSync && !d.items.length) {
    // A consumer key and secret authenticate an *application* and can only
    // reach public endpoints. Reading a collection identifies a person, so it
    // needs a personal token — different credential, same settings page.
    const half = d.scope === 'catalogue';
    return (
      <div className="empty cd-setup">
        <p><b>{half ? 'Discogs can search, but not read your collection yet.' : 'Discogs is not connected yet.'}</b></p>
        {half ? (
          <p>The consumer key and secret are set, and those authenticate the <i>app</i> against
            the public catalogue. Reading <i>your</i> collection identifies <i>you</i>, which needs
            a personal access token instead.</p>
        ) : null}
        <p>
          On <a href="https://www.discogs.com/settings/developers" target="_blank" rel="noreferrer">discogs.com/settings/developers</a>,
          scroll past the OAuth app box to <b>Generate new token</b>. Add it to the Pi&apos;s <code>.env</code> as
          <code>DISCOGS_TOKEN</code> and restart the web container.
        </p>
      </div>
    );
  }

  const needle = q.trim().toLowerCase();
  const rows = d.items.filter((c) =>
    (filter === 'all' || c.status === filter)
    && (!needle || `${c.artist} ${c.title} ${c.catno ?? ''}`.toLowerCase().includes(needle)));

  const tiles: Array<[string, number]> = [
    ['To rip', d.counts.shelf], ['Ripping', d.counts.ripping],
    ['Ripped', d.counts.ripped], ['On the shelf', d.counts.total],
  ];

  return (
    <>
      <div className="tiles">
        {tiles.map(([label, n]) => <div className="tile" key={label}><b>{n}</b><span>{label}</span></div>)}
      </div>
      <div className="tools cd-tools">
        <button className="primary-action" type="button" disabled={!d.canSync || sync.isPending} onClick={() => sync.mutate()}>
          {sync.isPending ? 'Syncing…' : 'Sync from Discogs'}
        </button>
        <span className="sub">
          {d.sync.synced_at ? `synced ${day(d.sync.synced_at)}${d.sync.username ? ` from ${d.sync.username}` : ''}` : 'never synced'}
        </span>
        <span className="cd-filters">
          {FILTERS.map(([key, label]) => (
            <button key={key} type="button" className={filter === key ? 'on' : undefined} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </span>
        <input type="search" placeholder="Filter the shelf..." value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </div>
      <div className="cd-grid">
        {rows.length ? rows.map((c) => {
          // cover_url is Discogs' full-size image; thumb_url is ~150px and reads
          // blurry the moment the card is wider than that.
          const art = c.cover_url || c.thumb_url;
          return (
            <div className={`al-card cd-card cd-${c.status}`} key={c.release_id}>
              <span className="al-art">
                {art ? <img src={art} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  : <span className="ph">{initial(c.artist)}</span>}
                <span className="al-when cd-state">{STATUS_LABEL[c.status]}</span>
              </span>
              <div className="al-body">
                <b>{c.title}</b>
                <span className="sub">{c.artist}</span>
                <span className="sub dim">{[c.year, c.format, c.catno].filter(Boolean).join(' · ')}</span>
              </div>
              <div className="cd-actions">
                <button type="button" onClick={() => setStatus.mutate({ releaseId: c.release_id, status: NEXT[c.status] })}>
                  {STATUS_LABEL[NEXT[c.status]]}
                </button>
                {c.status === 'skip' ? null : (
                  <button type="button" className="ghost" onClick={() => setStatus.mutate({ releaseId: c.release_id, status: 'skip' })}>Skip</button>
                )}
              </div>
            </div>
          );
        }) : <Empty>nothing {filter === 'all' ? 'on the shelf' : `marked "${STATUS_LABEL[filter as CdItem['status']] ?? filter}"`} yet</Empty>}
      </div>
    </>
  );
}
