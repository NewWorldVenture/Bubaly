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
