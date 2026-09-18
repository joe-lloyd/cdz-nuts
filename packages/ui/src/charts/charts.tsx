// The data visualisations, ported from the old SVG string builders.
//
// Series identity is fixed and deliberate: this app is always magenta, Spotify
// always teal. That pair is CVD-separated and sits in the dark-mode lightness
// band, so the two series stay distinguishable without relying on hue alone.

import type { Bucket, StackPoint } from '../api/types.ts';
import { Empty } from '../components/primitives.tsx';

export const VIZ = { app: '#d93bb4', spotify: '#279c7e', faint: 'rgba(244, 232, 242, .09)' };

export const VizLegend = ({ pairs }: { pairs: Array<[string, string]> }) => (
  <div className="viz-legend">
    {pairs.map(([label, color]) => (
      <span key={label}><i style={{ background: color }} />{label}</span>
    ))}
  </div>
);

export function MonthChart({ data, word = 'liked' }: { data: Array<{ month: string; n: number }>; word?: string | undefined }) {
  if (!data.length) return <Empty>no data</Empty>;
  const W = 640, H = 150, pad = 4;
  const bw = Math.max(2, Math.floor(W / data.length) - 2);
  const max = Math.max(...data.map((d) => d.n));
  const peak = data.reduce((a, b) => (b.n > a.n ? b : a));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%' }}>
      {data.map((d, i) => {
        const h = Math.max(2, Math.round((d.n / max) * (H - 30)));
        const x = Math.round((i / data.length) * W);
        return (
          <g key={d.month}>
            <title>{`${d.month} · ${d.n} ${word}`}</title>
            {d === peak ? <text x={x + bw / 2} y={H - h - 26} textAnchor="middle">{d.n}</text> : null}
            <rect x={x} y={H - h - 20} width={bw} height={h} rx={2} fill="var(--accent)" />
          </g>
        );
      })}
      <text x={pad} y={H - 6}>{data[0]!.month}</text>
      <text x={W - pad} y={H - 6} textAnchor="end">{data[data.length - 1]!.month}</text>
    </svg>
  );
}

/** Spotify at the base, this app on top; quiet days as faint ticks. */
export function StackChart({ points, labelOf }: { points: StackPoint[]; labelOf: (p: StackPoint) => string }) {
  if (!points.length) return <Empty>no data</Empty>;
  const W = 660, H = 170, base = H - 20;
  const bw = Math.max(3, Math.floor(W / points.length) - 3);
  const max = Math.max(...points.map((p) => p.spotify + p.app), 1);
  const scale = (n: number) => Math.round((n / max) * (H - 52));
  const peak = points.reduce((a, b) => (b.spotify + b.app > a.spotify + a.app ? b : a));
  const peakN = peak.spotify + peak.app;
  const px = Math.round((points.indexOf(peak) / points.length) * W) + bw / 2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%' }}>
      {peakN ? (
        <text x={Math.min(Math.max(px, 12), W - 12)} y={base - Math.max(scale(peakN), 4) - 8} textAnchor="middle">{peakN}</text>
      ) : null}
      {points.map((p, i) => {
        const x = Math.round((i / points.length) * W);
        const hs = p.spotify ? Math.max(scale(p.spotify), 2) : 0;
        const ha = p.app ? Math.max(scale(p.app), 2) : 0;
        const total = p.spotify + p.app;
        return (
          <g key={i}>
            <title>{`${labelOf(p)} · ${total} play${total === 1 ? '' : 's'}${p.app ? ` (${p.spotify} Spotify · ${p.app} here)` : ''}`}</title>
            <rect x={x} y={base - 2} width={bw} height={H} fill="transparent" />
            {total === 0 ? <rect x={x} y={base - 2} width={bw} height={2} fill={VIZ.faint} /> : null}
            {hs ? <rect x={x} y={base - hs} width={bw} height={hs} rx={2} fill={VIZ.spotify} /> : null}
            {ha ? <rect x={x} y={base - hs - (hs ? 2 : 0) - ha} width={bw} height={ha} rx={2} fill={VIZ.app} /> : null}
          </g>
        );
      })}
      <text x={0} y={H - 4}>{labelOf(points[0]!)}</text>
      <text x={W} y={H - 4} textAnchor="end">{labelOf(points[points.length - 1]!)}</text>
    </svg>
  );
}

/** Single-series rhythm bars — hours of the day, days of the week. */
export function RhythmChart({ buckets, labels, tipOf }: {
  buckets: Bucket[];
  labels: Array<[number, string]>;
  tipOf: (b: Bucket, i: number) => string;
}) {
  if (!buckets.length) return <Empty>no data</Empty>;
  const W = 660, H = 130, base = H - 20;
  const bw = Math.max(4, Math.floor(W / buckets.length) - 4);
  const max = Math.max(...buckets.map((b) => b.n), 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%' }}>
      {buckets.map((b, i) => {
        const x = Math.round((i / buckets.length) * W);
        const h = b.n ? Math.max(Math.round((b.n / max) * (H - 40)), 2) : 0;
        return (
          <g key={i}>
            <title>{tipOf(b, i)}</title>
            <rect x={x} y={0} width={bw} height={base} fill="transparent" />
            {h
              ? <rect x={x} y={base - h} width={bw} height={h} rx={2} fill={VIZ.app} />
              : <rect x={x} y={base - 2} width={bw} height={2} fill={VIZ.faint} />}
          </g>
        );
      })}
      {labels.map(([i, text]) => (
        <text key={text} x={Math.round((i / buckets.length) * W)} y={H - 4}>{text}</text>
      ))}
    </svg>
  );
}

/** Cumulative share of plays over ranked tracks: how deep the obsession runs. */
export function RabbitChart({ points, halfIndex }: { points: Array<{ name: string; pct: number }>; halfIndex: number }) {
  if (points.length < 2) return null;
  const W = 660, H = 84, base = H - 16, top = 8;
  const x = (i: number) => Math.round((i / Math.max(points.length - 1, 1)) * (W - 8)) + 4;
  const y = (pct: number) => Math.round(base - (pct / 100) * (base - top));
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.pct)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%' }}>
      <line x1={4} y1={y(50)} x2={W - 4} y2={y(50)} stroke="rgba(244,232,242,.14)" strokeDasharray="3 4" />
      <path d={`${path} L${x(points.length - 1)},${base} L${x(0)},${base} Z`} fill="rgba(217,59,180,.13)" />
      <path d={path} fill="none" stroke={VIZ.app} strokeWidth={2} />
      {halfIndex >= 0 ? <circle cx={x(halfIndex)} cy={y(points[halfIndex]!.pct)} r={4.5} fill={VIZ.app} stroke="#0a080a" strokeWidth={2} /> : null}
      <text x={4} y={H - 6}>#1</text>
      <text x={4} y={y(50) - 5}>50%</text>
      <text x={W - 4} y={H - 6} textAnchor="end">{`#${points.length}`}</text>
    </svg>
  );
}

/** The horizontal bars used for fidelity tiers and provenance. */
export function ProvBars({ rows, total }: {
  rows: Array<{ key: string; label: string; color: string; n: number }>;
  total: number;
}) {
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.key} style={{ display: 'contents' }}>
          <div className="lbl">{r.label}</div>
          <div
            className="bar"
            style={{ width: `${Math.max(2, Math.round((r.n / total) * 100))}%`, background: r.color }}
            title={`${r.label} · ${r.n.toLocaleString()} files`}
          />
          <div className="n">{r.n.toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

/** Gold centre, silver left, bronze right. */
export function Podium({ steps }: {
  steps: Array<{ href?: string | null | undefined; name: string; sub: string; pic: React.ReactNode }>;
}) {
  if (!steps.length) return null;
  return (
    <div className="podium">
      {[1, 0, 2].filter((i) => steps[i]).map((i) => {
        const s = steps[i]!;
        const inner = (
          <>
            <span className={`medal m${i + 1}`}>{i + 1}</span>
            {s.pic}
            <b>{s.name}</b>
            <small>{s.sub}</small>
          </>
        );
        return s.href
          ? <a key={i} className={`step p${i + 1}`} style={{ '--i': i } as React.CSSProperties} href={s.href}>{inner}</a>
          : <span key={i} className={`step p${i + 1}`} style={{ '--i': i } as React.CSSProperties}>{inner}</span>;
      })}
    </div>
  );
}
