// Dependency-free SVG chart primitives for the admin console. Server components
// (no interactivity) so they can be rendered directly in server pages.
import { fmtMoney } from '@/lib/utils/format';

export function Sparkline({ data, color = '#7c5dff' }: { data: number[]; color?: string }) {
  const max = Math.max(...data, 1);
  const w = 200, h = 48;
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const points = data.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Gauge({ pct, color, centerLabel }: { pct: number; color: string; centerLabel?: string }) {
  const r = 30, c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <svg width="84" height="84" viewBox="0 0 84 84">
      <circle cx="42" cy="42" r={r} fill="none" stroke="currentColor" strokeWidth="9" className="text-border" />
      <circle cx="42" cy="42" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
        strokeDasharray={`${dash} ${c - dash}`} transform="rotate(-90 42 42)" />
      <text x="42" y="42" textAnchor="middle" dominantBaseline="central" className="fill-current" fontSize={centerLabel ? '11' : '15'} fontWeight="bold">
        {centerLabel ?? `${pct}%`}
      </text>
    </svg>
  );
}

export function Donut({ segments, total }: { segments: { value: number; color: string }[]; total: number }) {
  const r = 30, c = 2 * Math.PI * r;
  const safe = total || 1;
  let cumulative = 0;
  return (
    <svg width="84" height="84" viewBox="0 0 84 84" className="shrink-0">
      <circle cx="42" cy="42" r={r} fill="none" stroke="currentColor" strokeWidth="10" className="text-border" />
      {segments.map((s, i) => {
        if (!s.value) return null;
        const dash = (s.value / safe) * c;
        const offset = c - cumulative * c / safe;
        cumulative += s.value;
        return <circle key={i} cx="42" cy="42" r={r} fill="none" stroke={s.color} strokeWidth="10"
          strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={offset} transform="rotate(-90 42 42)" />;
      })}
      <text x="42" y="42" textAnchor="middle" dominantBaseline="central" className="fill-current" fontSize="15" fontWeight="bold">{total}</text>
    </svg>
  );
}

/** Thick donut with a center total + caption. Segments are absolute values. */
export function BigDonut({
  segments, centerTop, centerBottom, size = 168,
}: {
  segments: { value: number; color: string }[];
  centerTop: string; centerBottom?: string; size?: number;
}) {
  const r = 56, sw = 18, c = 2 * Math.PI * r;
  const total = segments.reduce((a, b) => a + b.value, 0) || 1;
  let cum = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 144 144" className="h-full w-full">
        <circle cx="72" cy="72" r={r} fill="none" stroke="currentColor" strokeWidth={sw} className="text-border" />
        {segments.map((s, i) => {
          if (!s.value) return null;
          const dash = (s.value / total) * c;
          const offset = c - cum * c / total;
          cum += s.value;
          return <circle key={i} cx="72" cy="72" r={r} fill="none" stroke={s.color} strokeWidth={sw}
            strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={offset} transform="rotate(-90 72 72)" strokeLinecap="butt" />;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-lg font-bold leading-none">{centerTop}</span>
        {centerBottom && <span className="mt-1 text-[10px] text-muted">{centerBottom}</span>}
      </div>
    </div>
  );
}

/** Filled area chart with y-axis ticks + x-axis labels. Server-rendered SVG. */
export function AreaChartSVG({
  points, money = false, height = 180,
}: {
  points: { label: string; value: number }[]; money?: boolean; height?: number;
}) {
  const w = 640, h = height, padL = 48, padB = 22, padT = 8;
  const max = Math.max(...points.map((p) => p.value), 1);
  const niceMax = Math.ceil(max / 4) * 4 || 4;
  const innerW = w - padL - 8, innerH = h - padB - padT;
  const step = points.length > 1 ? innerW / (points.length - 1) : 0;
  const xy = points.map((p, i) => [padL + i * step, padT + innerH - (p.value / niceMax) * innerH] as const);
  const line = xy.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = xy.length ? `${padL},${padT + innerH} ${line} ${(padL + (points.length - 1) * step).toFixed(1)},${padT + innerH}` : '';
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));
  const fmtY = (v: number) => money ? (v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${v}`) : String(v);
  const everyX = Math.max(1, Math.floor(points.length / 6));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7c5dff" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#7c5dff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((t, i) => {
        const y = padT + innerH - (t / niceMax) * innerH;
        return (
          <g key={i}>
            <line x1={padL} y1={y} x2={w - 8} y2={y} stroke="currentColor" strokeWidth="1" className="text-border/50" />
            <text x={padL - 8} y={y + 3} textAnchor="end" fontSize="9" className="fill-current text-muted">{fmtY(t)}</text>
          </g>
        );
      })}
      {area && <polygon points={area} fill="url(#area-grad)" />}
      {line && <polyline points={line} fill="none" stroke="#8a6bff" strokeWidth="2" strokeLinejoin="round" />}
      {points.map((p, i) => i % everyX === 0 ? (
        <text key={i} x={padL + i * step} y={h - 6} textAnchor="middle" fontSize="9" className="fill-current text-muted">{p.label}</text>
      ) : null)}
    </svg>
  );
}

/** Bar chart. When `money` is set, bar titles are formatted as currency. */
export function Bars({ data, max, money = false }: { data: { label: string; value: number }[]; max: number; money?: boolean }) {
  return (
    <div className="flex h-24 items-end justify-between gap-1.5">
      {data.map((d) => (
        <div key={d.label} className="flex flex-1 flex-col items-center gap-1">
          <div className="flex w-full flex-1 items-end">
            <div className="w-full rounded-t bg-gradient-to-t from-violet-600 to-blue-500"
              style={{ height: `${Math.max(4, (d.value / max) * 100)}%` }}
              title={money ? fmtMoney(d.value) : String(d.value)} />
          </div>
          <span className="text-[10px] text-muted">{d.label}</span>
        </div>
      ))}
    </div>
  );
}
