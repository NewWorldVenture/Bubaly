'use client';

// Financial Copilot — mobile-first schedule↔money timeline. Renders the ranked
// copilot insights (acknowledge / dismiss, persisted) and the forward, week-
// bucketed cash-flow view with a running projected balance. Pure presentation
// over the CashflowTimeline the server built; writes go through server actions.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Sparkles, TrendingDown, CalendarClock, Target, RefreshCw,
  Check, X, AlertTriangle, Wallet, ChevronDown, ShieldCheck, ArrowRight,
} from 'lucide-react';
import type { CashflowTimeline, TimelineInsight, InsightSeverity, MomentKind, PlanSource } from '@/lib/finance/timeline';
import { money as moneyIn, pretty as prettyIn } from '@/lib/finance/timeline';
import { setMoneyInsightStatusAction, syncMoneyInsightsAction } from '@/app/(app)/dashboard/money-timeline/actions';
import { cn } from '@/lib/utils/cn';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';

type KeyedInsight = TimelineInsight & { key: string };
/** dedupe key -> 'active' | 'acknowledged' | 'dismissed'. */
type StatusMap = Record<string, string>;

const SEV: Record<InsightSeverity, { ring: string; chip: string; icon: string; label: string }> = {
  urgent: { ring: 'border-rose-400/40 bg-rose-500/[0.07]', chip: 'bg-rose-500/15 text-rose-300', icon: 'text-rose-400', label: 'Urgent' },
  watch:  { ring: 'border-amber-400/40 bg-amber-500/[0.06]', chip: 'bg-amber-500/15 text-amber-300', icon: 'text-amber-400', label: 'Watch' },
  info:   { ring: 'border-border bg-surface', chip: 'bg-brand/15 text-brand-text', icon: 'text-brand-text', label: 'Note' },
};

/** Dot colour per money-moment kind: bills amber, recurring brand, goals
 *  emerald, plan-linked commitments sky, a what-if scenario violet. */
const MOMENT_DOT: Record<MomentKind, string> = {
  bill: 'bg-amber-400',
  recurring: 'bg-brand',
  goal: 'bg-emerald-400',
  plan: 'bg-sky-400',
  scenario: 'bg-violet-400',
};

const PLAN_SOURCE_LABEL: Record<PlanSource, { label: string; labelKey: string }> = {
  subscription: { label: 'Subscription', labelKey: 'moneyTimelineModule.subscription' },
  vacation: { label: 'Trip', labelKey: 'moneyTimelineModule.trip' },
  move: { label: 'Move', labelKey: 'moneyTimelineModule.move' },
  project: { label: 'Project', labelKey: 'moneyTimelineModule.project' },
};

const KIND_ICON: Record<string, typeof Sparkles> = {
  low_balance: TrendingDown,
  heavy_week: CalendarClock,
  goal_at_risk: Target,
  recurring_creep: RefreshCw,
  set_aside: Wallet,
  all_clear: Sparkles,
};

/**
 * The cards a reader actually sees, from the family's persisted statuses plus
 * any optimistic override this session has applied. Exported because it is the
 * thing the family notices, so a test can assert on it directly rather than on
 * the state that feeds it.
 */
export function visibleInsights<T extends { key: string }>(
  insights: T[],
  statusByKey: StatusMap,
  overrides: StatusMap,
): T[] {
  return insights.filter((i) => (overrides[i.key] ?? statusByKey[i.key] ?? 'active') !== 'dismissed');
}

/**
 * What to show once the server has answered. An optimistic override is a
 * PROMISE that the write landed; when the action says it did not, the promise
 * has to be taken back — otherwise the card stays gone for the rest of the page
 * session and reappears on the next load with nothing to explain it, which is
 * exactly the "a copilot that keeps re-raising an alert we cleared" complaint.
 *
 * It returns an UPDATER, not a finished map. React applies it to whatever the
 * overrides are when it runs, so settling one card touches that card's key and
 * nothing else — it can never write back a snapshot taken before another card's
 * override was set.
 */
export function settleWrite(
  key: string,
  previous: string,
  result: { ok: boolean; error?: string } | undefined | null,
  fallbackMessage: string,
): { apply: (overrides: StatusMap) => StatusMap; error: string | null } {
  if (result?.ok) return { apply: (overrides) => overrides, error: null };
  return {
    apply: (overrides) => ({ ...overrides, [key]: previous }),
    error: result?.error || fallbackMessage,
  };
}

export function MoneyTimelineModule({
  timeline,
  insights,
  statusByKey,
  canManage,
}: {
  timeline: CashflowTimeline;
  insights: KeyedInsight[];
  statusByKey: Record<string, string>;
  /** Whether this reader may clear the household's advisories. Mirrors 0352. */
  canManage: boolean;
}) {
  const t = useTranslations();
  // Amounts and week labels follow the reader; the currency stays the money's own.
  const locale = useLocale();
  const money = (n: number) => moneyIn(n, locale.code);
  const pretty = (ymdStr: string) => prettyIn(ymdStr, locale.code);
  const [overrides, setOverrides] = useState<StatusMap>({});
  // A plain flag, not useTransition: the work below has to be AWAITED so a
  // refusal can roll the card back, and React 18's startTransition does not
  // await an async callback — its pending flag would clear before the server
  // answered, which is how the spinner used to say "saved" either way.
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const statusOf = (key: string) => overrides[key] ?? statusByKey[key] ?? 'active';

  const visible = visibleInsights(insights, statusByKey, overrides);

  const act = async (insight: KeyedInsight, status: 'acknowledged' | 'dismissed' | 'active') => {
    const previous = statusOf(insight.key);
    setActionError(null);
    setOverrides((o) => ({ ...o, [insight.key]: status }));
    setBusy(true);
    // Functional, so it composes with whatever else is in the map by then.
    const settle = (result: { ok: boolean; error?: string } | null) => {
      const settled = settleWrite(insight.key, previous, result, t('moneyTimeline.weCouldNotSaveThatChoice'));
      setOverrides(settled.apply);
      setActionError(settled.error);
    };
    try {
      settle(await setMoneyInsightStatusAction({ insight, status }));
    } catch (err) {
      // A transport failure is not a saved choice either. Put the card back and
      // say so rather than leaving the reader with a silent success.
      console.error('[money-timeline] insight status write failed', err);
      settle(null);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setActionError(null);
    setBusy(true);
    try {
      const result = await syncMoneyInsightsAction();
      if (!result?.ok) setActionError(result?.error || t('moneyTimeline.weCouldNotRefreshTheseInsights'));
    } catch (err) {
      console.error('[money-timeline] insight refresh failed', err);
      setActionError(t('moneyTimeline.weCouldNotRefreshTheseInsights'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-black sm:text-3xl">
            <Sparkles className="h-6 w-6 text-brand-text" /> {t('moneyTimeline.financialCopilot')}
          </h1>
          <p className="mt-1 max-w-xl text-sm text-muted">
            {t('moneyTimeline.yourMoneyAndYourCalendarOn')}
          </p>
        </div>
        {canManage && (
          <button
            onClick={refresh}
            disabled={busy}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface px-4 text-sm font-semibold transition hover:bg-elevated disabled:opacity-60"
          >
            <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} /> {t('moneyTimeline.refresh')}
          </button>
        )}
      </header>

      {/* Stat row */}
      <section className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t('moneyTimeline.liquidToday')} value={money(timeline.startingBalance)} tone="fg" />
        <Stat
          label={t('moneyTimeline.projectedLow')}
          value={money(timeline.lowestBalance)}
          sub={timeline.lowestBalanceWeek ? `wk of ${pretty(timeline.lowestBalanceWeek)}` : undefined}
          tone={timeline.lowestBalance < 0 ? 'rose' : timeline.lowestBalance < 200 ? 'amber' : 'emerald'}
        />
        <Stat
          label={t('moneyTimeline.dueNext12Wks')}
          value={money(timeline.totalOutflow)}
          sub={timeline.planOutflow > 0 ? t('moneyTimelineModule.amountFromTripsMovesProjects', { amount: money(timeline.planOutflow) }) : undefined}
          tone="fg"
        />
        {/* "covered by autopay" counts BILLS, not their occurrences — one
            monthly autopay rent is one covered bill, not three. */}
        <Stat
          label={t('moneyTimeline.recurringMo')}
          value={money(timeline.monthlyRecurring)}
          sub={timeline.coverage.coveredBills > 0 ? t('moneyTimelineModule.nBillsCoveredByAutopay', { n: timeline.coverage.coveredBills }) : undefined}
          tone="fg"
        />
      </section>

      <p className="mt-3 text-xs text-muted">
        <Link href="/dashboard/family-cfo" className="inline-flex items-center gap-1 font-medium text-brand-text hover:underline">
          {t('moneyTimelineModule.askCanWeAffordIt')} <ArrowRight className="h-3 w-3" />
        </Link>
      </p>

      {/* Insights */}
      <section className="mt-7">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted">{t('moneyTimeline.copilotInsights')}</h2>
        {actionError && (
          <p role="alert" className="mt-3 rounded-xl border border-rose-400/40 bg-rose-500/[0.07] p-3 text-sm text-rose-300">
            {actionError}
          </p>
        )}
        <div className="mt-3 space-y-3">
          {visible.length === 0 && (
            <p className="rounded-2xl border border-border bg-surface p-4 text-sm text-muted">
              {/* The manager's line says "you've cleared" and "Tap Refresh";
                  a child or guest did neither and has no Refresh button. */}
              {canManage
                ? t('moneyTimeline.allCaughtUpYouveClearedEvery')
                : t('moneyTimeline.allCaughtUpNothingNeedsAttention')}
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
                      {acknowledged && <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400"><Check className="h-3 w-3" /> {t('moneyTimeline.noted')}</span>}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted">{i.detail}</p>
                    {i.kind !== 'all_clear' && canManage && (
                      <div className="mt-3 flex items-center gap-2">
                        {!acknowledged && (
                          <button
                            onClick={() => { void act(i, 'acknowledged'); }}
                            disabled={busy}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand/15 px-3 text-xs font-bold text-brand-text transition hover:bg-brand/25 disabled:opacity-60"
                          >
                            <Check className="h-3.5 w-3.5" /> {t('moneyTimeline.gotIt')}
                          </button>
                        )}
                        <button
                          onClick={() => { void act(i, 'dismissed'); }}
                          disabled={busy}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted transition hover:bg-elevated disabled:opacity-60"
                        >
                          <X className="h-3.5 w-3.5" /> {t('moneyTimeline.dismiss')}
                        </button>
                      </div>
                    )}
                    {/* Not a dead-end button for a child or a guest: the
                        forecast is theirs to read, the household's triage
                        state is not theirs to change (0352). */}
                    {i.kind !== 'all_clear' && !canManage && (
                      <p className="mt-3 text-[11px] text-muted">
                        {t('moneyTimeline.aParentOrAnotherAdultClearsThese')}
                      </p>
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
  const t = useTranslations();
  // Amounts and week labels follow the reader; the currency stays the money's own.
  const locale = useLocale();
  const money = (n: number) => moneyIn(n, locale.code);
  const pretty = (ymdStr: string) => prettyIn(ymdStr, locale.code);
  const [expanded, setExpanded] = useState<string | null>(null);
  const maxOutflow = useMemo(
    () => Math.max(1, ...timeline.weeks.map((w) => w.outflow)),
    [timeline.weeks],
  );

  return (
    <section className="mt-8">
      <h2 className="text-sm font-bold uppercase tracking-wide text-muted">{t('moneyTimeline.next12Weeks')}</h2>
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
                        <AlertTriangle className="h-2.5 w-2.5" /> {t('moneyTimeline.heavy')}
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
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', MOMENT_DOT[m.kind] ?? 'bg-amber-400')} />
                        <span className="truncate text-muted">{m.label}</span>
                        {m.source && (
                          <span className="shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                            {t(PLAN_SOURCE_LABEL[m.source].labelKey)}
                          </span>
                        )}
                        {m.covered && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400">
                            <ShieldCheck className="h-2.5 w-2.5" /> {t('moneyTimelineModule.covered')}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 tabular-nums text-fg">{money(m.amount)}</span>
                    </div>
                  ))}
                  {w.events.length > 0 && (
                    <p className="pt-1 text-[11px] text-muted">{t('moneyTimeline.onTheCalendar')} {w.events.join(' · ')}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted">{t('moneyTimelineModule.projectedBalanceAssumesYourCurrent')} {t('moneyTimelineModule.planLinkedCommitmentsTripsMoves')}</p>
    </section>
  );
}
