'use client';
// Interactive User Growth panel for the admin dashboard. Receives a full daily
// series (up to 365 real data points from Supabase) and lets the admin slice it
// to 7D / 30D / 90D / 1Y entirely client-side — no refetch.
import { useMemo, useState } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

type Range = '7D' | '30D' | '90D' | '1Y';
const RANGES: { key: Range; days: number }[] = [
  { key: '7D', days: 7 },
  { key: '30D', days: 30 },
  { key: '90D', days: 90 },
  { key: '1Y', days: 365 },
];

export function UserGrowthPanel({ series }: { series: { date: string; count: number }[] }) {
  const [range, setRange] = useState<Range>('30D');
  const days = RANGES.find((r) => r.key === range)!.days;

  const data = useMemo(() => series.slice(-days), [series, days]);
  const total = data.reduce((a, b) => a + b.count, 0);
  const half = Math.floor(data.length / 2);
  const firstHalf = data.slice(0, half).reduce((a, b) => a + b.count, 0);
  const secondHalf = data.slice(half).reduce((a, b) => a + b.count, 0);
  const deltaPct = firstHalf > 0 ? Math.round(((secondHalf - firstHalf) / firstHalf) * 100) : secondHalf > 0 ? 100 : 0;
  const up = deltaPct >= 0;

  const w = 320, h = 120, pad = 4;
  const max = Math.max(...data.map((d) => d.count), 1);
  const step = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0;
  const pts = data.map((d, i) => [pad + i * step, h - pad - (d.count / max) * (h - pad * 2)] as const);
  const line = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = pts.length
    ? `${pad},${h - pad} ${line} ${(pad + (data.length - 1) * step).toFixed(1)},${h - pad}`
    : '';

  const tickEvery = Math.max(1, Math.floor(data.length / 4));
  const fmt = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">User Growth</p>
          <p className="text-xs text-muted">New users in the last {range === '1Y' ? 'year' : `${days} days`}</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-surface/40 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${
                range === r.key ? 'bg-brand text-white' : 'text-muted hover:text-fg'
              }`}
            >
              {r.key}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums">+{total.toLocaleString()}</span>
        <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
          {up ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
          {Math.abs(deltaPct)}%
        </span>
      </div>

      <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-28 w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="growth-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c5dff" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#7c5dff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {area && <polygon points={area} fill="url(#growth-fill)" />}
        {line && <polyline points={line} fill="none" stroke="#8a6bff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        {data.filter((_, i) => i % tickEvery === 0).map((d) => (
          <span key={d.date}>{fmt(d.date)}</span>
        ))}
      </div>
    </div>
  );
}
