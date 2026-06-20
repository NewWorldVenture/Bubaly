/** Generic donut chart — pass labels/counts/colors, renders SVG + legend. */
export function StatusDonut({
  segments,
  total,
  centerLabel = 'Total',
}: {
  segments: { label: string; count: number; color: string }[];
  total: number;
  centerLabel?: string;
}) {
  const circ = 2 * Math.PI * 40;
  let offset = 0;
  const arcs = segments.map((s) => {
    const dash = total > 0 ? (s.count / total) * circ : 0;
    const arc = { ...s, dash, offset };
    offset += dash;
    return arc;
  });

  return (
    <div className="flex items-center gap-5">
      <div className="relative h-28 w-28 shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="14" />
          {arcs.map((a) => (
            <circle
              key={a.label}
              cx="50" cy="50" r="40"
              fill="none"
              stroke={a.color}
              strokeWidth="14"
              strokeDasharray={`${a.dash} ${circ}`}
              strokeDashoffset={-a.offset}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-black">{total.toLocaleString()}</span>
          <span className="text-[9px] text-muted">{centerLabel}</span>
        </div>
      </div>
      <ul className="flex-1 space-y-1.5 text-sm">
        {segments.map((s) => {
          const pct = total > 0 ? ((s.count / total) * 100).toFixed(1) : '0.0';
          return (
            <li key={s.label} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="flex-1 text-muted">{s.label}</span>
              <span className="font-medium">{s.count.toLocaleString()} ({pct}%)</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
