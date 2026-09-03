import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useListenBrainz, useStats, useStation, useTopArtists } from '../api/hooks.ts';
import { post } from '../api/client.ts';
import { dur } from '../lib/format.ts';
import { Empty, MediaBadges, PLAY_ICON, PlayControl, RadioControl, Skeleton } from '../components/primitives.tsx';
import { PlayScope, toQueueItem, usePlayAll } from '../components/PlayScope.tsx';
import { player } from '../player/usePlayer.ts';
import type { Track } from '../api/types.ts';

const StationLink = ({ kind, value, label, sub }: { kind: string; value: string; label: string; sub?: string | undefined }) => (
  <Link className="station-card" to={`/radio/${kind}/${encodeURIComponent(value)}`}>
    <span className="station-wave" aria-hidden="true"><i /><i /><i /><i /></span>
    <b>{label}</b>{sub ? <span className="sub">{sub}</span> : null}
  </Link>
);

export function Radio() {
  const lb = useListenBrainz();
  const top = useTopArtists();
  const stats = useStats();
  if (lb.isPending) return <Skeleton />;
  if (!lb.data?.enabled) {
    return <Empty>Radio is off — no ListenBrainz token is configured.</Empty>;
  }
  const artists = [...new Map((top.data ?? []).filter((a) => a.name).map((a) => [a.name, a])).values()].slice(0, 12);
  const tags = (stats.data?.genres ?? []).slice(0, 12);
  const listens = lb.data.listens?.submitted ?? 0;

  return (
    <>
      <p className="lede">
        Pick a starting point. Every station mixes records you own with records you do not —
        the new ones are fetched while the old ones play.
      </p>
      <h2>Built from your listening</h2>
      {listens ? (
        <div className="station-grid">
          <StationLink kind="stats" value={lb.data.user ?? ''} label="Your top tracks" sub={`${listens} listens reported`} />
          <StationLink kind="recs" value={lb.data.user ?? ''} label="Recommended for you" sub="ListenBrainz picks" />
        </div>
      ) : (
        <Empty>
          Nothing reported to ListenBrainz yet — these two stations switch on once you have played
          a few things. Every play is submitted automatically as <b>{lb.data.user || 'your account'}</b>.
        </Empty>
      )}
      <h2>From artists you play</h2>
      {artists.length ? (
        <div className="station-grid">
          {artists.map((a) => <StationLink key={a.name} kind="artist" value={a.name} label={a.name} sub="and artists like them" />)}
        </div>
      ) : <Empty>play something first and this fills itself in</Empty>}
      {tags.length ? (
        <>
          <h2>By genre</h2>
          <div className="station-grid">
            {tags.map((g) => (
              <StationLink key={g.genre} kind="tag" value={g.genre} label={g.genre}
                sub={`${g.n} liked track${g.n === 1 ? '' : 's'}`} />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

const RADIO_STATE: Record<string, string> = {
  'not-queued': 'queued shortly', pending_source: 'downloading', working: 'downloading',
  queued: 'waiting', retry_wait: 'retrying', exhausted: 'could not find it', cancelled: 'cancelled',
};
const GAVE_UP = new Set(['exhausted', 'cancelled']);

/**
 * Keep a station a few tracks ahead of the listener.
 *
 * A LEAD, not a rate. The first version of this asked for three more on every
 * poll regardless of how many were already running, so a 40-track station
 * queued all forty inside three minutes — and someone who skips away after two
 * songs should not leave 38 downloads behind them.
 */
const LEAD = 5;

interface ResolveResponse {
  results?: Array<{ key: string; status: string; ready?: boolean; track?: Track }>;
}

export function Station() {
  const params = useParams();
  const kind = params.kind;
  // A station seed is an artist name or a genre, not an id -- it can contain
  // slashes and spaces -- so it arrives as the splat rather than a segment.
  const value = params['*'] ? decodeURIComponent(params['*']) : undefined;
  const { data, isPending, error } = useStation(kind, value);
  const playAll = usePlayAll();

  const [resolved, setResolved] = useState<Record<string, Track>>({});
  const [states, setStates] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());

  const tracks = data?.tracks ?? [];
  const keyOf = (t: Track) => t.recording_mbid || `${t.artists ?? ''}|${t.name}`;
  const pending = tracks.filter((t) => t.pending && !resolved[keyOf(t)]);

  useEffect(() => {
    // A new station is a new set of rows; forget what the last one was doing.
    requested.current = new Set();
    setResolved({});
    setStates({});
  }, [kind, value]);

  useEffect(() => {
    if (!pending.length) return;
    let live = true;

    const specOf = (t: Track) => ({
      artist: t.artists ?? '', title: t.name, album: t.album ?? null,
      durationMs: Number(t.duration_ms ?? 0) || null,
      recordingMbid: t.recording_mbid ?? null,
      // The release id is a direct key into Cover Art Archive: it is what lets
      // a web-sourced single wear the actual record sleeve.
      releaseMbid: t.release_mbid ?? null,
    });

    const topUp = () => {
      const inFlight = pending.filter((t) => requested.current.has(keyOf(t)) && !GAVE_UP.has(states[keyOf(t)] ?? '')).length;
      const need = Math.max(0, LEAD - inFlight);
      if (!need) return;
      const next = pending.filter((t) => !requested.current.has(keyOf(t))).slice(0, need);
      if (!next.length) return;
      for (const t of next) requested.current.add(keyOf(t));
      void post('/api/radio/fetch', { tracks: next.map(specOf) }).catch(() => {});
    };

    const poll = async () => {
      if (!live || !pending.length) return;
      try {
        const res = await post<ResolveResponse>('/api/radio/resolve', { tracks: pending.map(specOf) });
        if (!live) return;
        const arrived: Track[] = [];
        const nextStates: Record<string, string> = {};
        const nextResolved: Record<string, Track> = {};
        for (const r of res.results ?? []) {
          if (r.ready && r.track) { nextResolved[r.key] = r.track; arrived.push(r.track); }
          else nextStates[r.key] = r.status;
        }
        if (Object.keys(nextResolved).length) setResolved((prev) => ({ ...prev, ...nextResolved }));
        if (Object.keys(nextStates).length) setStates((prev) => ({ ...prev, ...nextStates }));
        // Straight onto the end of the queue, so a station already playing
        // carries on into tracks it just went and got.
        if (arrived.length) player.append(arrived.map(toQueueItem));
      } catch { /* the next tick tries again */ }
      topUp();
    };

    topUp();
    const timer = setInterval(() => void poll(), 12_000);
    return () => { live = false; clearInterval(timer); };
  }, [pending.length, kind, value, states]);

  if (isPending) return <Skeleton />;
  if (error) return <Empty>{error.message}</Empty>;
  if (data?.error || !tracks.length) {
    const why = data?.error === 'ListenBrainz is not configured'
      ? 'Radio is off — no ListenBrainz token is configured.'
      : `Nothing came back for this station${data?.error ? ` (${data.error})` : ''}.`;
    return <Empty>{why} <Link to="/radio">Pick another</Link></Empty>;
  }

  const seed = data!.seedTrack;
  const label = kind === 'stats' ? 'Your top tracks'
    : kind === 'recs' ? 'Recommended for you'
    : kind === 'track' ? (seed ? `Songs like ${seed.title}` : 'Song radio')
    : `${value} radio`;
  // Say which question was actually answered: a song with no neighbours in the
  // similarity data quietly becomes artist radio, and that is a different
  // station than the one that was asked for.
  const basis = kind !== 'track' ? ''
    : data!.source === 'similar' ? `songs that get played alongside this one${seed ? ` · ${seed.artist}` : ''}`
    : data!.source === 'similar+artist' ? 'few close matches for this song, so it widens out to the artist'
    : 'nothing close enough to this song, so this is artist radio';

  // Pending rows become ordinary playable rows in place as they arrive.
  const rows = tracks.map((t) => resolved[keyOf(t)] ?? t);
  const playable = rows.filter((t) => !t.pending);

  return (
    <>
      <div className="station-head">
        <div>
          <h1>{label}</h1>
          <div className="meta">{data!.owned} in your library · {data!.fresh} new to you</div>
          {basis ? <div className="meta dim">{basis}</div> : null}
        </div>
        <div className="hero-actions">
          <button className="primary-action play-station" type="button" onClick={() => playAll(playable, false)}>
            {PLAY_ICON} Play station
          </button>
          {kind === 'track' && seed ? (
            <Link className="spbtn" to={`/radio/artist/${encodeURIComponent(seed.artist)}`}>{seed.artist} radio</Link>
          ) : null}
          <Link className="spbtn" to="/radio">Another station</Link>
        </div>
      </div>

      {/* A station does not continue into album autoplay when it runs out. */}
      <PlayScope tracks={playable} continueAfter={false}>
        <div className="rows">
          {rows.map((t, i) => t.pending ? (
            <div className="row radio-pending" key={`${keyOf(t)}-${i}`}>
              <span className="rank"><span className="radio-dot" aria-hidden="true" /></span>
              <div className="mid">
                <div>{t.name}</div>
                <div className="sub">{t.artists ?? ''}{t.album ? ` · ${t.album}` : ''}</div>
              </div>
              <div className="song-badges"><span className="chip radio-new">new to you</span></div>
              <div className="end radio-state">
                {RADIO_STATE[states[keyOf(t)] ?? 'not-queued'] ?? states[keyOf(t)]}
              </div>
            </div>
          ) : (
            <div className="row" key={`${t.id}-${i}`} data-track-id={t.id}>
              <span className="rank"><span className="radio-have" title="already in your library">●</span></span>
              <PlayControl track={t} />
              <div className="mid">
                <div>{t.name}</div>
                <div className="sub">{t.artists ?? ''}{t.album ? ` · ${t.album}` : ''}</div>
              </div>
              <MediaBadges row={t} />
              <div className="end">{dur(t.duration_ms)}</div>
              <RadioControl track={t} />
            </div>
          ))}
        </div>
      </PlayScope>
    </>
  );
}
