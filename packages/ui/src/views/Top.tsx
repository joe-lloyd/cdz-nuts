import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useTopArtists, useTopTracks, useWrapped } from '../api/hooks.ts';
import { dur, genres as parseGenres } from '../lib/format.ts';
import { Podium, RabbitChart } from '../charts/charts.tsx';
import { Empty, Pic, PlayControl, Skeleton, SpotifyLink } from '../components/primitives.tsx';
import { PlayScope } from '../components/PlayScope.tsx';
import type { Artist, Track } from '../api/types.ts';

const RANGES: Array<[string, string]> = [
  ['short_term', '4 weeks'], ['medium_term', '6 months'], ['long_term', 'years'],
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const PRESETS: Array<[string, string, string]> = [
  ['All time', '0000', '9999'],
  ['12 months', iso(new Date(Date.now() - 365 * 864e5)), '9999'],
  ['3 months', iso(new Date(Date.now() - 91 * 864e5)), '9999'],
  ['4 weeks', iso(new Date(Date.now() - 28 * 864e5)), '9999'],
];

export function Top() {
  const [mode, setMode] = useState<'plays' | 'rank'>('plays');
  const [range, setRange] = useState('medium_term');
  const [preset, setPreset] = useState(0);

  return (
    <>
      <div className="tools">
        <div className="seg">
          <button type="button" className={mode === 'plays' ? 'on' : undefined} onClick={() => setMode('plays')}>By plays</button>
          <button type="button" className={mode === 'rank' ? 'on' : undefined} onClick={() => setMode('rank')}>Spotify ranking</button>
        </div>
        {mode === 'rank' ? (
          <div className="seg">
            {RANGES.map(([key, label]) => (
              <button key={key} type="button" className={range === key ? 'on' : undefined} onClick={() => setRange(key)}>{label}</button>
            ))}
          </div>
        ) : (
          <div className="seg">
            {PRESETS.map(([label], i) => (
              <button key={label} type="button" className={preset === i ? 'on' : undefined} onClick={() => setPreset(i)}>{label}</button>
            ))}
          </div>
        )}
      </div>
      {mode === 'rank' ? <ByRank range={range} /> : <ByPlays from={PRESETS[preset]![1]} to={PRESETS[preset]![2]} />}
    </>
  );
}

function movement(row: { id: string; rank?: number | null }, era: Map<string, number> | null) {
  if (!era) return null;
  const was = era.get(row.id);
  const rank = row.rank ?? 0;
  if (was == null) return <span className="move new">new</span>;
  if (was > rank) return <span className="move up">▲{was - rank}</span>;
  if (was < rank) return <span className="move down">▼{rank - was}</span>;
  return <span className="move flat">=</span>;
}

function ByRank({ range }: { range: string }) {
  const artists = useTopArtists(range);
  const tracks = useTopTracks(range);
  // Movement is against the all-time ranking, so there is nothing to compare
  // when you are already looking at it.
  const eraArtists = useTopArtists(range === 'long_term' ? undefined : 'long_term');
  const eraTracks = useTopTracks(range === 'long_term' ? 'long_term' : 'long_term');

  if (artists.isPending || tracks.isPending) return <Empty>ranking…</Empty>;
  const a = artists.data ?? [];
  const t = tracks.data ?? [];
  const artistEra = range === 'long_term' ? null : new Map((eraArtists.data ?? []).map((x) => [x.id, x.rank ?? 0]));
  const trackEra = range === 'long_term' ? null : new Map((eraTracks.data ?? []).map((x) => [x.id, x.rank ?? 0]));

  // Genre mix of the era, weighted by how high each artist ranks.
  const weight = new Map<string, number>();
  for (const artist of a) {
    for (const g of parseGenres(artist.genres, 4)) {
      weight.set(g, (weight.get(g) ?? 0) + Math.max(1, 40 - (artist.rank ?? 40)));
    }
  }
  const topGenres = [...weight.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8);
  const gwMax = Math.max(...topGenres.map(([, w]) => w), 1);

  return (
    <>
      <Podium steps={a.slice(0, 3).map((x: Artist) => ({
        href: `/artist/${x.id}`, name: x.name,
        sub: parseGenres(x.genres, 2).join(', ') || 'your podium',
        pic: <Pic kind="artists" id={x.id} cdn={x.image_url} name={x.name} />,
      }))} />
      {artistEra ? <div className="note">▲▼ movement vs your all-time ranking</div> : null}
      <div className="cards">
        <div className="card">
          <h2>Top artists</h2>
          <div className="rows">
            {a.slice(3).map((x, i) => (
              <div className="row top-row" key={x.id} style={{ '--i': i } as React.CSSProperties}>
                <span className="rank">{x.rank}</span>
                <Link to={`/artist/${x.id}`}><Pic kind="artists" id={x.id} cdn={x.image_url} name={x.name} /></Link>
                <div className="mid">
                  <div><Link to={`/artist/${x.id}`}>{x.name}</Link> {movement(x, artistEra)}</div>
                  <div className="sub">{parseGenres(x.genres, 2).join(', ')}</div>
                </div>
                <SpotifyLink type="artist" id={x.id} />
              </div>
            ))}
            {a.length ? null : <Empty>not synced yet</Empty>}
          </div>
        </div>
        <div className="card">
          <h2>Top tracks</h2>
          <PlayScope tracks={t}>
            <div className="rows">
              {t.map((x: Track, i) => (
                <div className="row top-row" key={x.id} style={{ '--i': i } as React.CSSProperties} data-track-id={x.id}>
                  <span className="rank">{x.rank}</span>
                  <PlayControl track={x} />
                  <div className="mid">
                    <div>{x.name} {movement(x, trackEra)}</div>
                    <div className="sub">{x.artists ?? ''}</div>
                  </div>
                  <div className="end">{dur(x.duration_ms)}</div>
                  <SpotifyLink type="track" id={x.id} />
                </div>
              ))}
              {t.length ? null : <Empty>not synced yet</Empty>}
            </div>
          </PlayScope>
        </div>
        <div className="card">
          <h2>The sound of this era</h2>
          {topGenres.length ? (
            <div className="bars">
              {topGenres.map(([g, w]) => (
                <div key={g} style={{ display: 'contents' }}>
                  <div className="lbl">{g}</div>
                  <div className="bar" style={{ width: `${Math.round((w / gwMax) * 100)}%` }} title={g} />
                  <div className="n" />
                </div>
              ))}
            </div>
          ) : <Empty>genres still hydrating</Empty>}
        </div>
      </div>
    </>
  );
}

function ByPlays({ from, to }: { from: string; to: string }) {
  const { data, isPending } = useWrapped(from, to);
  if (isPending) return <Empty>counting…</Empty>;
  const d = data!;
  const t = d.totals;
  if (!t?.plays) {
    return <Empty>no plays in this range — the API capture builds from now on</Empty>;
  }
  const months = d.perMonth?.length || 1;
  const tiles: Array<[string, number]> = [
    ['plays', t.plays], ['hours', Math.round((t.ms ?? 0) / 3.6e6)],
    ['different tracks', t.tracks], ['different artists', t.artists],
    ['plays a month', Math.round(t.plays / months)],
  ];

  const insights: string[] = [];
  const tt = d.topTracks[0];
  if (tt) insights.push(`${tt.track_name} ruled this era — ${tt.plays} plays, ${((tt.plays / t.plays) * 100).toFixed(1)}% of everything you heard`);
  const peak = (d.perMonth ?? []).reduce<{ month: string; n: number } | null>((a, b) => (b.n > (a?.n ?? 0) ? b : a), null);
  if (peak && months > 1) insights.push(`Loudest month: ${peak.month}, ${peak.n} plays`);
  const ta = d.topArtists[0];
  if (ta) insights.push(`You gave ${ta.artist_name} ${Math.round(ta.ms / 3.6e6)} hours — ${((ta.ms / t.ms) * 100).toFixed(1)}% of all listening`);

  let cum = 0;
  const curve = d.topTracks.map((x) => { cum += x.plays; return { name: x.track_name, pct: (cum / t.plays) * 100 }; });
  const halfIndex = curve.findIndex((p) => p.pct >= 50);

  const aMax = Math.max(...d.topArtists.map((x) => x.plays), 1);
  const kMax = Math.max(...d.topTracks.map((x) => x.plays), 1);
  const bMax = Math.max(...d.topAlbums.map((x) => x.plays), 1);

  return (
    <>
      <Podium steps={d.topArtists.slice(0, 3).map((x) => ({
        href: x.artist_id ? `/artist/${x.artist_id}` : null,
        name: x.artist_name, sub: `${x.plays} plays · ${Math.round(x.ms / 3.6e6)}h`,
        pic: <Pic kind="artists" id={x.artist_id} cdn={x.image_url} name={x.artist_name} />,
      }))} />
      <div className="tiles">
        {tiles.map(([k, v]) => <div className="tile" key={k}><b>{v.toLocaleString()}</b><span>{k}</span></div>)}
      </div>
      {insights.length ? (
        <div className="insights">
          {insights.map((text, i) => <div className="insight" key={i} style={{ '--i': i } as React.CSSProperties}><p>{text}</p></div>)}
        </div>
      ) : null}
      {curve.length > 2 ? (
        <div className="rabbit-strip">
          <div className="rabbit-copy">
            <span className="eyebrow">The rabbit hole</span>
            <p className="rabbit-line">
              {halfIndex >= 0
                ? <>Half of everything you played is just <b>{halfIndex + 1} track{halfIndex ? 's' : ''}</b>.</>
                : <>Certified explorer — your top {curve.length} tracks are only <b>{curve[curve.length - 1]!.pct.toFixed(0)}%</b> of your plays.</>}
            </p>
          </div>
          <div className="rabbit-viz"><RabbitChart points={curve} halfIndex={halfIndex} /></div>
        </div>
      ) : null}
      <div className="cards">
        <div className="card">
          <h2>Top artists</h2>
          <div className="rows">
            {d.topArtists.slice(3).map((x, i) => (
              <div className="row top-row" key={`${x.artist_name}-${i}`} style={{ '--i': i } as React.CSSProperties}>
                <span className="rank">{i + 4}</span>
                <Pic kind="artists" id={x.artist_id} cdn={x.image_url} name={x.artist_name} />
                <div className="mid">
                  <div>{x.artist_id ? <Link to={`/artist/${x.artist_id}`}>{x.artist_name}</Link> : x.artist_name}</div>
                  <div className="sub">{Math.round(x.ms / 3.6e6)}h</div>
                  <i className="sharebar" style={{ '--w': `${Math.round((x.plays / aMax) * 100)}%` } as React.CSSProperties} />
                </div>
                <div className="end">{x.plays}×</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <h2>Top tracks</h2>
          <div className="rows">
            {d.topTracks.map((x, i) => (
              <div className="row top-row" key={`${x.track_name}-${i}`} style={{ '--i': i } as React.CSSProperties}>
                <span className="rank">{i + 1}</span>
                <div className="mid">
                  <div>{x.track_name}</div>
                  <div className="sub">{x.artist_name ?? ''}</div>
                  <i className="sharebar" style={{ '--w': `${Math.round((x.plays / kMax) * 100)}%` } as React.CSSProperties} />
                </div>
                <div className="end">{x.plays}×</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <h2>Top albums</h2>
          <div className="rows">
            {d.topAlbums.map((x, i) => (
              <div className="row top-row" key={`${x.album_name}-${i}`} style={{ '--i': i } as React.CSSProperties}>
                <span className="rank">{i + 1}</span>
                <Pic kind="albums" id={x.album_id} cdn={x.image_url} name={x.album_name} />
                <div className="mid">
                  <div>{x.album_id ? <Link to={`/album/${x.album_id}`}>{x.album_name}</Link> : x.album_name}</div>
                  <div className="sub">{x.artist_name ?? ''}</div>
                  <i className="sharebar" style={{ '--w': `${Math.round((x.plays / bMax) * 100)}%` } as React.CSSProperties} />
                </div>
                <div className="end">{x.plays}×</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export { Skeleton };
