'use client';

// The context rail (§54 right): what Bubaly is looking at today — the glance
// numbers, what is coming up, recent activity — and the prompts worth trying.
// It is the same on a desktop's right column and on the phone's Context tab.
//
// The module loads the data (it owns the Supabase reads); this component
// renders it, with a skeleton while loading and an error the person can
// retry rather than a silent set of zeros.
import { CalendarDays } from 'lucide-react';
import { ErrorState, SkeletonText } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';

export type GlanceItem = { icon: React.ComponentType<{ className?: string }>; value: string; label: string };
export type UpcomingEvent = { id: string; title: string; starts_at: string; all_day: boolean };
export type ActivityItem = { icon: React.ComponentType<{ className?: string }>; text: string; time: string; color: string };
export type PromptSuggestion = { icon: React.ComponentType<{ className?: string }>; text: string };

const ACCENT_COLORS = ['bg-emerald-500', 'bg-indigo-500', 'bg-orange-500', 'bg-rose-500'];

export type ContextRailProps = {
  glance: GlanceItem[];
  upcoming: UpcomingEvent[];
  activity: ActivityItem[];
  prompts: PromptSuggestion[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onAsk: (text: string) => void;
  className?: string;
};

export function ContextRail({ glance, upcoming, activity, prompts, loading = false, error = null, onRetry, onAsk, className }: ContextRailProps) {
  return (
    <div className={cn('space-y-5', className)}>
      {error && <ErrorState message={error} onRetry={onRetry} />}

      <RailCard title="At a glance">
        {loading ? (
          <SkeletonText lines={2} />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {glance.map(({ icon: Icon, value, label }) => (
              <div key={label} className="rounded-xl border border-border bg-bg/40 p-3">
                <Icon className="h-5 w-5 text-brand-text" aria-hidden />
                <p className="mt-2 text-2xl font-black leading-none tabular-nums">{value}</p>
                <p className="mt-1 text-xs text-muted">{label}</p>
              </div>
            ))}
          </div>
        )}
      </RailCard>

      <RailCard title="Coming up" action={<a href="/dashboard/calendar" className="focus-ring rounded text-xs font-semibold text-brand-text">Calendar</a>}>
        {loading ? (
          <SkeletonText lines={3} />
        ) : upcoming.length > 0 ? (
          <ul>
            {upcoming.map((e, i) => {
              const d = new Date(e.starts_at);
              return (
                <li key={e.id} className="flex items-center gap-3 py-2.5">
                  <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full text-white', ACCENT_COLORS[i % ACCENT_COLORS.length])}>
                    <CalendarDays className="h-5 w-5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{e.title}</p>
                    <p className="text-xs text-muted">
                      {d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                      {!e.all_day && ` · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-4 text-center text-sm text-muted/60">Nothing coming up</p>
        )}
      </RailCard>

      <RailCard title="Try asking">
        <ul>
          {prompts.map(({ icon: Icon, text }) => (
            <li key={text}>
              <button
                type="button"
                onClick={() => onAsk(text)}
                className="focus-ring coarse:min-h-11 flex w-full gap-3 rounded-lg px-1 py-2.5 text-left transition hover:bg-elevated"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/10">
                  <Icon className="h-4 w-4 text-brand-text" aria-hidden />
                </span>
                <span className="text-xs leading-5 text-fg/80">{text}</span>
              </button>
            </li>
          ))}
        </ul>
      </RailCard>

      <RailCard title="Recent activity" action={<a href="/dashboard/activity" className="focus-ring rounded text-xs font-semibold text-brand-text">All</a>}>
        {loading ? (
          <SkeletonText lines={2} />
        ) : activity.length > 0 ? (
          <ul>
            {activity.map((a) => (
              <li key={a.text} className="flex items-center gap-3 py-2 text-xs">
                <a.icon className={cn('h-4 w-4 shrink-0', a.color)} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-fg/80">{a.text}</span>
                <span className="shrink-0 text-muted/60">{a.time}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-3 text-center text-xs text-muted/60">No recent activity</p>
        )}
      </RailCard>
    </div>
  );
}

function RailCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface/40 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
