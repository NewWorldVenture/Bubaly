import { ROLE_LABELS, ROLE_ORDER, type MemberRole } from '@/lib/constants/roles';

const COLORS: Record<MemberRole, string> = {
  parent: '#a78bfa', adult: '#34d399', teen: '#60a5fa', child: '#fbbf24', caregiver: '#f472b6', guest: '#94a3b8',
};

/** Real role-distribution donut — same stroke-dasharray technique used across billing/health modules. */
export function RoleDonut({ counts, total }: { counts: Map<MemberRole, number>; total: number }) {
  const circ = 2 * Math.PI * 40;
  let offset = 0;
  const arcs = ROLE_ORDER.map((role) => {
    const count = counts.get(role) ?? 0;
    const dash = total > 0 ? (count / total) * circ : 0;
    const arc = { role, count, dash, offset, color: COLORS[role] };
    offset += dash;
    return arc;
  }).filter((a) => a.count > 0);

  return (
    <div className="flex items-center gap-5">
      <div className="relative h-28 w-28 shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="14" />
          {arcs.map((a) => (
            <circle key={a.role} cx="50" cy="50" r="40" fill="none" stroke={a.color} strokeWidth="14"
              strokeDasharray={`${a.dash} ${circ}`} strokeDashoffset={-a.offset} />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-black">{total.toLocaleString()}</span>
          <span className="text-[9px] text-muted">Total</span>
        </div>
      </div>
      <ul className="flex-1 space-y-1.5 text-sm">
        {ROLE_ORDER.map((role) => {
          const count = counts.get(role) ?? 0;
          const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
          return (
            <li key={role} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: COLORS[role] }} />
              <span className="flex-1 truncate text-muted">{ROLE_LABELS[role].split(' / ')[0]}</span>
              <span className="font-medium">{count.toLocaleString()} ({pct}%)</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
