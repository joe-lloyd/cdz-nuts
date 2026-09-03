import { Link } from 'react-router-dom';

import { useOverview, useProvenance, useReleases } from '../api/hooks.ts';
import { ago, releaseDay } from '../lib/format.ts';
import { MonthChart, ProvBars, RhythmChart, StackChart, VIZ, VizLegend } from '../charts/charts.tsx';
import { AlbumCell } from '../components/rows.tsx';
import { Empty, Skeleton } from '../components/primitives.tsx';
import type { QualityTier, StackPoint } from '../api/types.ts';

const TIER_META: Array<[QualityTier, string, string]> = [
  ['hires', 'Hi-res', 'var(--gold)'],
  ['lossless', 'Lossless', 'var(--accent)'],
  ['high', 'High · 320k', '#c9b2c4'],
  ['standard', 'Standard', '#8a7f88'],
  ['low', 'Low', '#5c545b'],
];
const SRC_LABEL: Record<string, string> = {
  external: 'External', youtube: 'Web streams', cd: 'CD rips', unknown: 'Before records began',
};
const sourceKey = (k: string) => (k === 'youtube' || k === 'cd' || k === 'unknown' ? k : 'external');

const dayLabel = (p: StackPoint) =>
  new Date(`${p.d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const monthLabel = (p: StackPoint) => p.m ?? '';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function Overview() {
  const overview = useOverview();
  const provenance = useProvenance();
  const releases = useReleases();

  if (overview.isPending) return <Skeleton />;
  if (overview.error) return <Empty>{overview.error.message} — is the database there yet?</Empty>;
  const o = overview.data!;
  const c = o.counts;

  const delta = o.playsPrev30 ? Math.round(((o.plays30 - o.playsPrev30) / o.playsPrev30) * 100) : null;
  const trend = delta == null ? 'The record starts here — every play in this player now counts too.'
    : delta >= 0 ? `Up ${delta}% on the month before.`
    : `Down ${-delta}% on the month before — quieter days.`;

  const tiles: Array<[string, string | number]> = [
    ['artists in your taste', c.tasteArtists], ['liked songs', c.liked],
    ['saved albums', c.albums], ['playlists', c.playlists],
    ['plays on record', Number(c.totalPlays).toLocaleString()],
    ['played right here', Number(c.appPlays).toLocaleString()],
    ...(o.history.rows ? [['lifetime hours', Number(o.history.hours).toLocaleString()] as [string, string]] : []),
  ];

  const rotMax = Math.max(...o.topArtists.map((a) => a.n), 1);
  const prov = provenance.data;

  // Folded before sorting, so the merged bar ranks on its real total rather
  // than on whichever of its parts happened to be largest.
  const folded: Record<string, number> = {};
  for (const [k, n] of Object.entries(prov?.sources ?? {})) {
    const key = sourceKey(k);
    folded[key] = (folded[key] ?? 0) + n;
  }

  return (
    <>
      <section className="overview-hero">
        <div>
          <span className="eyebrow">Last 30 days · Spotify + this player</span>
          <h2>{Number(o.plays30).toLocaleString()} plays, <em>{o.hours30} hours.</em></h2>
          <p>{trend}</p>
        </div>
        <aside className="hero-signal">
          <span>Downloaded now</span>
          <b>{Number(c.downloaded ?? 0).toLocaleString()} albums</b>
          <small>{o.downloadsSyncedAt ? `Library checked ${ago(o.downloadsSyncedAt)}` : 'Waiting for the first library snapshot'}</small>
        </aside>
      </section>

      <div className="tiles">
        <div className="tile download-tile">
          <b>{(c.downloaded ?? 0).toLocaleString()}</b>
          <span>albums downloaded{o.downloadsSyncedAt ? ` · ${ago(o.downloadsSyncedAt)}` : ''}</span>
        </div>
        {tiles.map(([k, v]) => <div className="tile" key={k}><b>{v}</b><span>{k}</span></div>)}
      </div>

      <div className="cards">
        <div className="card wide">
          <h2>Daily listening — the last five weeks</h2>
          <VizLegend pairs={[['Spotify', VIZ.spotify], ['This player', VIZ.app]]} />
          <StackChart points={o.daily} labelOf={dayLabel} />
        </div>
        <div className="card">
          <h2>The listening clock</h2>
          <RhythmChart buckets={o.hours} labels={[[0, '00'], [6, '06'], [12, '12'], [18, '18']]}
            tipOf={(b) => `${b.k}:00 – ${b.k}:59 · ${b.n} plays`} />
        </div>
        <div className="card">
          <h2>Day rhythm</h2>
          <RhythmChart buckets={o.weekdays} labels={WEEKDAYS.map((w, i) => [i, w])}
            tipOf={(b, i) => `${WEEKDAYS[i]} · ${b.n} plays`} />
        </div>
        <div className="card">
          <h2>Heavy rotation — 30 days</h2>
          {o.topArtists.length ? (
            <div className="rotation">
              {o.topArtists.map((a, i) => (
                <Link className="rot-row" to={`/artist/${a.id}`} key={a.id}>
                  <span className="rank">{i + 1}</span>
                  <b>{a.name}</b>
                  <i style={{ width: `${Math.round((a.n / rotMax) * 100)}%` }} />
                  <span className="n">{a.n}</span>
                </Link>
              ))}
            </div>
          ) : <Empty>play something — this fills itself in</Empty>}
        </div>
        <div className="card"><h2>Liked songs over the years</h2><MonthChart data={o.likedPerMonth} /></div>

        <div className="card">
          <h2>The library, honestly</h2>
          {prov?.total ? (
            <>
              <p className="note">{prov.total.toLocaleString()} files, scanned {ago(prov.scannedAt)}</p>
              <ProvBars total={prov.total} rows={TIER_META.filter(([k]) => prov.tiers[k])
                .map(([key, label, color]) => ({ key, label, color, n: prov.tiers[key]! }))} />
            </>
          ) : <Empty>the library scanner has not run yet</Empty>}
        </div>
        <div className="card">
          <h2>Where it all came from</h2>
          {prov?.total ? (
            <ProvBars total={prov.total} rows={Object.entries(folded).sort((a, b) => b[1] - a[1])
              .map(([key, n]) => ({
                key, n, label: SRC_LABEL[key] ?? key,
                color: key === 'external' ? 'var(--violet)' : key === 'youtube' ? 'var(--coral)' : 'var(--accent)',
              }))} />
          ) : <Empty>no provenance recorded yet</Empty>}
        </div>

        {o.lifetimeMonthly ? (
          <div className="card wide">
            <h2>Every month since the beginning</h2>
            <VizLegend pairs={[['Spotify', VIZ.spotify], ['This player', VIZ.app]]} />
            <StackChart points={o.lifetimeMonthly} labelOf={monthLabel} />
          </div>
        ) : null}
      </div>

      <ReleaseSection />
    </>
  );

  function ReleaseSection() {
    const rel = releases.data;
    if (!rel?.releases?.length) return null;
    const note = [
      rel.counts?.upcoming ? `${rel.counts.upcoming} still to come` : '',
      rel.counts?.missing ? `${rel.counts.missing} not downloaded` : '',
    ].filter(Boolean).join(' · ');
    return (
      <>
        <h2>New &amp; upcoming from the artists you follow</h2>
        {note ? <p className="sub dim rel-note">{note}</p> : null}
        <div className="al-grid">
          {rel.releases.map((r, i) => (
            <AlbumCell
              key={`${r.id ?? r.name}-${i}`} album={r}
              when={r.upcoming && r.release_date ? `out ${releaseDay(r.release_date)}` : undefined}
              extraClass={r.upcoming ? 'al-upcoming' : undefined}
            />
          ))}
        </div>
      </>
    );
  }
}
