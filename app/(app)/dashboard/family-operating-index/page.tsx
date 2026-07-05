import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Gauge, TrendingUp, TrendingDown, Minus, ArrowRight, CalendarClock, ListChecks,
  CalendarX2, Wallet, Home as HomeIcon, MessageSquare, Repeat, Target, Sparkles,
  Moon, ArrowUpRight, ArrowDownRight, CheckCircle2, CircleDot,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { loadOperatingIndex } from '@/lib/operating-index/server';
import { DIMENSION_LABELS, type Band, type DimensionId } from '@/lib/operating-index/score';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Family Operating Index' };
export const dynamic = 'force-dynamic';

const BAND_COPY: Record<Band, { label: string; blurb: string; ring: string; text: string; chip: string }> = {
  thriving: { label: 'Thriving', blurb: 'The household is running smoothly — nice work.', ring: 'text-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', chip: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' },
  steady: { label: 'Steady', blurb: 'On top of things with a few easy wins available.', ring: 'text-brand', text: 'text-brand', chip: 'bg-brand/12 text-brand' },
  stretched: { label: 'Stretched', blurb: 'A handful of things need attention this week.', ring: 'text-amber-500', text: 'text-amber-600 dark:text-amber-400', chip: 'bg-amber-500/12 text-amber-600 dark:text-amber-400' },
  overloaded: { label: 'Overloaded', blurb: 'Several things are piling up — let’s clear the top ones.', ring: 'text-rose-500', text: 'text-rose-600 dark:text-rose-400', chip: 'bg-rose-500/12 text-rose-600 dark:text-rose-400' },
};

const DIM_ICON: Record<DimensionId, React.ComponentType<{ className?: string }>> = {
  planning: CalendarClock, routine: Repeat, stability: CalendarX2, financial: Wallet,
  readiness: HomeIcon, communication: MessageSquare, goals: Target,
};

const IMPACT_CHIP: Record<'high' | 'medium' | 'low', string> = {
  high: 'bg-rose-500/12 text-rose-600 dark:text-rose-400',
  medium: 'bg-amber-500/12 text-amber-600 dark:text-amber-400',
  low: 'bg-brand/10 text-brand',
};

function barColor(score: number): string {
  if (score >= 85) return 'bg-emerald-500';
  if (score >= 70) return 'bg-brand';
  if (score >= 50) return 'bg-amber-500';
  return 'bg-rose-500';
}

// The Family Operating Index — the measurable core of the Operating Layer.
// Every figure is computed live from real family-scoped data (lib/operating-index)
// and persisted as one snapshot per day so the composite can trend.
export default async function FamilyOperatingIndexPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { index, priorComposite, trend, change } = await loadOperatingIndex(supabase, ctx.active.familyId);
  const band = BAND_COPY[index.band];

  // SVG ring geometry.
  const R = 52, C = 2 * Math.PI * R;
  const dash = (index.composite / 100) * C;

  const TrendIcon = trend == null ? Minus : trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Minus;
  const trendText = trend == null
    ? 'First reading — check back tomorrow to see the trend.'
    : trend === 0 ? 'No change since your last reading.'
    : `${trend > 0 ? '+' : ''}${trend} vs. your last reading (${priorComposite}).`;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <PageHeader
        title="Family Operating Index"
        description="How well your household is running right now — with the highest-leverage things to do next. Not a grade; a to-do list."
      />

      {/* Composite dial + band */}
      <section className="rounded-2xl border border-border bg-surface/60 p-5 sm:p-6">
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:gap-7">
          <div className="relative grid h-36 w-36 shrink-0 place-items-center">
            <svg viewBox="0 0 120 120" className="h-36 w-36 -rotate-90">
              <circle cx="60" cy="60" r={R} fill="none" strokeWidth="10" className="stroke-border/60" />
              <circle
                cx="60" cy="60" r={R} fill="none" strokeWidth="10" strokeLinecap="round"
                className={cn('transition-all', band.ring)} stroke="currentColor"
                strokeDasharray={`${dash} ${C - dash}`}
              />
            </svg>
            <div className="absolute flex flex-col items-center">
              <span className={cn('text-4xl font-bold tabular-nums', band.text)}>{index.composite}</span>
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted">/ 100</span>
            </div>
          </div>
          <div className="min-w-0 flex-1 text-center sm:text-left">
            <div className="mb-1.5 flex items-center justify-center gap-2 sm:justify-start">
              <Gauge className={cn('h-4 w-4', band.text)} />
              <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', band.chip)}>{band.label}</span>
            </div>
            <p className="text-sm text-fg">{band.blurb}</p>
            <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted sm:justify-start">
              <TrendIcon className="h-3.5 w-3.5" /> {trendText}
            </p>
            {index.overloaded && (
              <p className="mt-1 text-xs text-muted">
                <span className="font-medium text-fg">{index.overloaded.name}</span> is carrying the most this week.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Since yesterday — the evening "what changed" recap (pillar #5) */}
      {!change.isFirst && (
        <section className="mt-5 rounded-2xl border border-border bg-surface/40 p-4 sm:p-5">
          <div className="mb-2 flex items-center gap-2">
            <Moon className="h-4 w-4 text-brand" />
            <h2 className="text-sm font-semibold">Since yesterday</h2>
          </div>
          <p className="text-sm text-fg">{change.headline}</p>
          {(change.resolved.length > 0 || change.emerged.length > 0 || change.improved.length > 0 || change.declined.length > 0) && (
            <div className="mt-3 grid gap-1.5 text-xs sm:grid-cols-2">
              {change.resolved.map((r) => (
                <div key={`r-${r.id}`} className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">Cleared: {r.title}</span>
                </div>
              ))}
              {change.emerged.map((e) => (
                <div key={`e-${e.id}`} className="flex items-center gap-1.5 text-muted">
                  <CircleDot className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">New: {e.title}</span>
                </div>
              ))}
              {change.improved.map((d) => (
                <div key={`i-${d.id}`} className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{d.label} +{d.delta}</span>
                </div>
              ))}
              {change.declined.map((d) => (
                <div key={`d-${d.id}`} className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                  <ArrowDownRight className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{d.label} {d.delta}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Top suggestions — the "system of execution" payoff */}
      <section className="mt-5">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-brand" /> Do these next
        </h2>
        {index.suggestions.length === 0 ? (
          <div className="rounded-2xl border border-border bg-surface/40 p-5 text-center text-sm text-muted">
            Nothing needs you right now — the household is in great shape. 🎉
          </div>
        ) : (
          <ul className="space-y-2">
            {index.suggestions.slice(0, 6).map((s) => (
              <li key={s.id}>
                <Link
                  href={s.href}
                  className="group flex items-center gap-3 rounded-xl border border-border bg-surface/60 p-3 transition hover:border-brand/40 hover:bg-elevated"
                >
                  <span className={cn('rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', IMPACT_CHIP[s.impact])}>
                    {s.impact}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{s.title}</span>
                    <span className="block text-xs text-muted">{s.detail}</span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Dimension breakdown */}
      <section className="mt-6">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <ListChecks className="h-4 w-4 text-brand" /> What went into the score
        </h2>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {index.dimensions.map((d) => {
            const Icon = DIM_ICON[d.id];
            return (
              <div key={d.id} className="rounded-xl border border-border bg-surface/60 p-3.5">
                <div className="mb-1 flex items-center gap-2">
                  <Icon className="h-4 w-4 text-muted" />
                  <span className="flex-1 text-sm font-medium">{DIMENSION_LABELS[d.id]}</span>
                  <span className="text-sm font-semibold tabular-nums">{d.score}</span>
                </div>
                <div className="mb-1.5 h-1.5 w-full overflow-hidden rounded-full bg-border/50">
                  <div className={cn('h-full rounded-full transition-all', barColor(d.score))} style={{ width: `${d.score}%` }} />
                </div>
                <p className="text-xs text-muted">{d.summary}</p>
              </div>
            );
          })}
        </div>
      </section>

      <p className="mt-5 text-center text-[11px] text-muted">
        Computed live from your family’s calendar, chores, bills, documents, approvals and goals.
        Saved once a day so you can watch the trend.
      </p>
    </div>
  );
}
