// R11 — the category metric on-surface. Renders "N hours saved this week" with a
// transparent breakdown. Server-compatible (no hooks); Home and the Experience
// Scorecard both render it. Hides when nothing has been handled yet.
import { Clock } from 'lucide-react';
import type { TimeSaved } from '@/lib/metric/time-saved';

export function TimeSavedBanner({ data }: { data: TimeSaved }) {
  if (!data.show) return null;
  const big = data.hours >= 1 ? `${data.hours} ${data.hours === 1 ? 'hour' : 'hours'}` : `${data.minutes} min`;
  return (
    <section className="rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/[0.09] to-surface/40 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-500/15 text-emerald-500">
          <Clock className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-bold leading-tight">
            {big} saved this week
            <span className="ml-2 align-middle text-xs font-medium text-muted">· {data.actions} things handled for you</span>
          </p>
          <p className="mt-0.5 text-xs text-muted">Time you didn&apos;t spend on family admin — the number we optimize for.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {data.rows.map((r) => (
              <span key={r.kind} className="rounded-full border border-border bg-surface/60 px-2.5 py-1 text-xs text-muted">
                <span className="font-semibold text-fg">{r.count}</span> {r.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
