'use client';

// Financial Copilot — mobile-first schedule↔money timeline. Renders the ranked
// copilot insights (acknowledge / dismiss, persisted) and the forward, week-
// bucketed cash-flow view with a running projected balance. Pure presentation
// over the CashflowTimeline the server built; writes go through server actions.
import { useMemo, useState, useTransition } from 'react';
import {
  Sparkles, TrendingDown, CalendarClock, Target, RefreshCw,
  Check, X, AlertTriangle, Wallet, ChevronDown,
} from 'lucide-react';
import type { CashflowTimeline, TimelineInsight, InsightSeverity } from '@/lib/finance/timeline';
import { money, pretty } from '@/lib/finance/timeline';
import { setMoneyInsightStatusAction, syncMoneyInsightsAction } from '@/app/(app)/dashboard/money-timeline/actions';
import { cn } from '@/lib/utils/cn';

type KeyedInsight = TimelineInsight & { key: string };

const SEV: Record<InsightSeverity, { ring: string; chip: string; icon: string; label: string }> = {
  urgent: { ring: 'border-rose-400/40 bg-rose-500/[0.07]', chip: 'bg-rose-500/15 text-rose-300', icon: 'text-rose-400', label: 'Urgent' },
  watch:  { ring: 'border-amber-400/40 bg-amber-500/[0.06]', chip: 'bg-amber-500/15 text-amber-300', icon: 'text-amber-400', label: 'Watch' },
  info:   { ring: 'border-border bg-surface', chip: 'bg-brand/15 text-brand-text', icon: 'text-brand-text', label: 'Note' },
};

const KIND_ICON: Record<string, typeof Sparkles> = {
  low_balance: TrendingDown,
  heavy_week: CalendarClock,
  goal_at_risk: Target,
  recurring_creep: RefreshCw,
  set_aside: Wallet,
  all_clear: Sparkles,
};

export function MoneyTimelineModule({
  timeline,
  insights,
  statusByKey,
}: {
  timeline: CashflowTimeline;
  insights: KeyedInsight[];
  statusByKey: Record<string, string>;
}) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const statusOf = (key: string) => overrides[key] ?? statusByKey[key] ?? 'active';

  const visible = insights.filter((i) => statusOf(i.key) !== 'dismissed');

  const act = (insight: KeyedInsight, status: 'acknowledged' | 'dismissed' | 'active') => {
    setOverrides((o) => ({ ...o, [insight.key]: status }));
    startTransition(() => { void setMoneyInsightStatusAction({ insight, status }); });
  };

  const refresh = () => startTransition(() => { void syncMoneyInsightsAction(); });

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-black sm:text-3xl">
            <Sparkles className="h-6 w-6 text-brand-text" /> Financial Copilot
          </h1>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Your money and your calendar on one timeline — so a heavy week never
            catches you off guard.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={pending}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface px-4 text-sm font-semibold transition hover:bg-elevated disabled:opacity-60"
        >
          <RefreshCw className={cn('h-4 w-4', pending && 'animate-spin')} /> Refresh
        </button>
      </header>

      {/* Stat row */}
      <section className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Liquid today" value={money(timeline.startingBalance)} tone="fg" />
        <Stat
          label="Projected low"
          value={money(timeline.lowestBalance)}
          sub={timeline.lowestBalanceWeek ? `wk of ${pretty(timeline.lowestBalanceWeek)}` : undefined}
          tone={timeline.lowestBalance < 0 ? 'rose' : timeline.lowestBalance < 200 ? 'amber' : 'emerald'}
        />
        <Stat label="Due · next 12 wks" value={money(timeline.totalOutflow)} tone="fg" />
        <Stat label="Recurring / mo" value={money(timeline.monthlyRecurring)} tone="fg" />
      </section>

      {/* Insights */}
      <section className="mt-7">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Copilot insights</h2>
        <div className="mt-3 space-y-3">
          {visible.length === 0 && (
            <p className="rounded-2xl border border-border bg-surface p-4 text-sm text-muted">
              All caught up — you’ve cleared every insight. Tap Refresh after adding bills or goals.
            </p>
          )}
          {visible.map((i) => {
            const sev = SEV[i.severity];
            const Icon = KIND_ICON[i.kind] ?? Sparkles;
            const acknowledged = statusOf(i.key) === 'acknowledged';
            return (
              <article key={i.key} className={cn('rounded-2xl border p-4 transition', sev.ring, acknowledged && 'opacity-70')}>
                <div className="flex items-start gap-3">
                  <span className={cn('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] ring-1 ring-white/10')}>
                    <Icon className={cn('h-5 w-5', sev.icon)} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-bold text-fg">{i.title}</h3>
                      <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', sev.chip)}>
                        {sev.label}
                      </span>
                      {acknowledged && <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400"><Check className="h-3 w-3" /> Noted</span>}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted">{i.detail}</p>
                    {i.kind !== 'all_clear' && (
                      <div className="mt-3 flex items-center gap-2">
                        {!acknowledged && (
                          <button
                            onClick={() => act(i, 'acknowledged')}
                            disabled={pending}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand/15 px-3 text-xs font-bold text-brand-text transition hover:bg-brand/25 disabled:opacity-60"
                          >
                            <Check className="h-3.5 w-3.5" /> Got it
                          </button>
                        )}
                        <button
                          onClick={() => act(i, 'dismissed')}
                          disabled={pending}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted transition hover:bg-elevated disabled:opacity-60"
                        >
                          <X className="h-3.5 w-3.5" /> Dismiss
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* Timeline */}
      <TimelineView timeline={timeline} />
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: 'fg' | 'rose' | 'amber' | 'emerald' }) {
  const toneCls = tone === 'rose' ? 'text-rose-400' : tone === 'amber' ? 'text-amber-400' : tone === 'emerald' ? 'text-emerald-400' : 'text-fg';
  return (
    <div className="rounded-2xl border border-border bg-surface p-3.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className={cn('mt-1 text-xl font-black tabular-nums', toneCls)}>{value}</p>
      {sub && <p className="text-[11px] text-muted">{sub}</p>}
    </div>
  );
}

function TimelineView({ timeline }: { timeline: CashflowTimeline }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const maxOutflow = useMemo(
    () => Math.max(1, ...timeline.weeks.map((w) => w.outflow)),
    [timeline.weeks],
  );

  return (
    <section className="mt-8">
      <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Next 12 weeks</h2>
      <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-surface">
        {timeline.weeks.map((w, idx) => {
          const active = w.outflow > 0 || w.events.length > 0;
          const isOpen = expanded === w.weekStart;
          const barPct = Math.round((w.outflow / maxOutflow) * 100);
          const negative = w.projectedBalance < 0;
          return (
            <div key={w.weekStart} className={cn('border-b border-border/60 last:border-b-0', idx === 0 && 'bg-white/[0.02]')}>
              <button
                onClick={() => active && setExpanded(isOpen ? null : w.weekStart)}
                className={cn('flex w-full items-center gap-3 px-4 py-3 text-left', active && 'hover:bg-elevated')}
                aria-expanded={isOpen}
              >
                <div className="w-14 shrink-0">
                  <p className="text-xs font-bold text-fg">{pretty(w.weekStart)}</p>
                  <p className="text-[10px] text-muted">wk {idx + 1}</p>
                </div>

                {/* Outflow bar */}
                <div className="min-w-0 flex-1">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-elevated">
                    <div
                      className={cn('h-full rounded-full', w.heavy ? 'bg-amber-400' : 'bg-brand/70')}
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {w.heavy && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                        <AlertTriangle className="h-2.5 w-2.5" /> Heavy
                      </span>
                    )}
                    {w.events.slice(0, 2).map((e) => (
                      <span key={e} className="inline-flex items-center gap-1 rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-muted">
                        <CalendarClock className="h-2.5 w-2.5" /> {e}
                      </span>
                    ))}
                    {w.events.length > 2 && <span className="text-[10px] text-muted">+{w.events.length - 2}</span>}
                  </div>
                </div>

                {/* Amounts */}
                <div className="shrink-0 text-right">
                  <p className={cn('text-sm font-bold tabular-nums', w.outflow > 0 ? 'text-fg' : 'text-muted')}>
                    {w.outflow > 0 ? `−${money(w.outflow)}` : '—'}
                  </p>
                  <p className={cn('text-[11px] tabular-nums', negative ? 'text-rose-400' : 'text-muted')}>
                    {money(w.projectedBalance)}
                  </p>
                </div>
                {active && <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted transition', isOpen && 'rotate-180')} />}
              </button>

              {isOpen && (
                <div className="space-y-1.5 border-t border-border/60 bg-bg/40 px-4 py-3">
                  {w.moments.map((m, k) => (
                    <div key={k} className="flex items-center justify-between gap-3 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', m.kind === 'goal' ? 'bg-emerald-400' : m.kind === 'recurring' ? 'bg-brand' : 'bg-amber-400')} />
                        <span className="truncate text-muted">{m.label}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-fg">{money(m.amount)}</span>
                    </div>
                  ))}
                  {w.events.length > 0 && (
                    <p className="pt-1 text-[11px] text-muted">On the calendar: {w.events.join(' · ')}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted">
        Projected balance assumes your current liquid balance minus scheduled bills, goal set-asides, and recurring costs. Income isn’t modeled yet.
      </p>
    </section>
  );
}
