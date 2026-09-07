import { getTranslations } from '@/lib/i18n/server';
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Real activity heatmap built from actual created_at timestamps — not simulated. */
export async function EngagementHeatmap({ timestamps }: { timestamps: string[] }) {
  const t = await getTranslations();
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const ts of timestamps) {
    const d = new Date(ts);
    const day = (d.getDay() + 6) % 7; // 0 = Monday
    grid[day][d.getHours()]++;
  }
  const max = Math.max(...grid.flat(), 1);

  const peaks = grid
    .flatMap((hours, day) => hours.map((count, hour) => ({ day, hour, count })))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const fmtHour = (h: number) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_220px]">
      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          <div className="grid" style={{ gridTemplateColumns: '40px repeat(24, 1fr)' }}>
            <div />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="text-center text-[9px] text-muted">{h % 3 === 0 ? fmtHour(h).replace(' ', '') : ''}</div>
            ))}
            {DAYS.map((label, day) => (
              <div key={label} className="contents">
                <div className="flex items-center text-xs text-muted">{label}</div>
                {grid[day].map((count, hour) => (
                  <div key={hour} className="aspect-square m-0.5 rounded-sm bg-brand" style={{ opacity: count > 0 ? 0.15 + (count / max) * 0.85 : 0.04 }} title={`${count} events`} />
                ))}
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-end gap-2 text-xs text-muted">
            Low <div className="h-2 w-24 rounded-full bg-gradient-to-r from-brand/10 to-brand" />{' '}{t('engagementHeatmap.high')}</div>
        </div>
      </div>
      <div className="rounded-xl border border-border bg-surface/40 p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('engagementHeatmap.peakActivity')}</h3>
        {peaks.length === 0 ? (
          <p className="text-sm text-muted">{t('engagementHeatmap.notEnoughActivityRecordedYet')}</p>
        ) : (
          <ol className="space-y-2 text-sm">
            {peaks.map((p, i) => (
              <li key={`${p.day}-${p.hour}`} className="flex items-center justify-between">
                <span className="text-muted">#{i + 1} {DAYS[p.day]} {fmtHour(p.hour)}</span>
                <span className="font-medium">{p.count}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
