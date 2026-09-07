'use client';

// Predictive Planning — "Next Best Actions". Merges the family's upcoming events,
// open tasks, and time-boxed opportunities into ONE prioritized worklist so the
// answer to "what should we do next?" is a real, ranked, one-tap list. 100%
// Supabase via useRealtimeQuery; ranking is the pure lib/opportunities/next-actions.
import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import {
  Target, CalendarPlus, CheckSquare, Trophy, Check, ArrowRight, Sparkles, AlertCircle,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { completeTodoAction } from '@/app/(app)/dashboard/todos/actions';
import { useToast } from '@/components/ui/toast';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { useJourney } from '@/lib/analytics/use-journey';
import { cn } from '@/lib/utils/cn';
import {
  rankNextActions, attentionCount, BUCKET_ORDER, BUCKET_LABELS,
  type ActionInput, type ActionSource, type ActionPriority,
} from '@/lib/opportunities/next-actions';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Event = Tables<'calendar_events'>;
type Task = Tables<'todo_items'>;
type Opp = Tables<'opportunities'>;

const SOURCE_META: Record<ActionSource, { icon: typeof Target; cls: string; label: string }> = {
  event: { icon: CalendarPlus, cls: 'text-blue-300 bg-blue-500/10 border-blue-500/30', label: 'Event' },
  task: { icon: CheckSquare, cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30', label: 'Task' },
  opportunity: { icon: Trophy, cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30', label: 'Opportunity' },
};

/** Local YYYY-MM-DD (en-CA renders ISO date). */
function dayKey(d: Date | string): string {
  return new Date(d).toLocaleDateString('en-CA');
}

const OPEN_OPP = new Set(['interested', 'registered', 'waitlisted']);
const PRIORITIES = new Set<ActionPriority>(['low', 'medium', 'high']);

export function NextActionsModule() {
  const i18nT = useTranslations();
  const tr = useTranslations();
  const { familyId } = useApp();
  const { success, error: toastError } = useToast();
  const journey = useJourney('next_actions');
  // Telemetry: the journey is "land here → clear an action". Starts on mount;
  // completes when the first task is cleared below.
  useEffect(() => {
    journey.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const today = dayKey(new Date());
  // 45-day horizon keeps the list focused on what's actually actionable soon.
  const horizon = dayKey(new Date(Date.now() + 45 * 86_400_000));

  const { data: events, loading: eventsLoading, error: eventsError, refresh: refreshEvents } = useRealtimeQuery<Event>({
    table: 'calendar_events', familyId, deps: [familyId],
    // Only upcoming events matter here (the list is trimmed to a 45-day horizon
    // below). Push that bound into the query instead of loading the family's ENTIRE
    // calendar history and filtering client-side — a generous window (yesterday →
    // +46 days) with a hard cap keeps the read bounded; the client trim stays exact.
    fetcher: (sb) => sb.from('calendar_events').select('*').eq('family_id', familyId)
      .gte('starts_at', new Date(Date.now() - 86_400_000).toISOString())
      .lte('starts_at', new Date(Date.now() + 46 * 86_400_000).toISOString())
      .order('starts_at', { ascending: true }).limit(500),
  });
  const { data: tasks, loading: tasksLoading, error: tasksError, refresh: refreshTasks } = useRealtimeQuery<Task>({
    table: 'todo_items', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('todo_items').select('*').eq('family_id', familyId).eq('is_done', false),
  });
  const { data: opps, loading: oppsLoading, error: oppsError, refresh: refreshOpps } = useRealtimeQuery<Opp>({
    table: 'opportunities', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('opportunities').select('*').eq('family_id', familyId),
  });

  const ranked = useMemo(() => {
    const inputs: ActionInput[] = [];
    for (const e of events ?? []) {
      const k = dayKey(e.starts_at);
      if (k < today || k > horizon) continue; // upcoming within the horizon only
      inputs.push({ id: `event:${e.id}`, source: 'event', title: e.title, whenKey: k, href: '/dashboard/calendar' });
    }
    for (const t of tasks ?? []) {
      inputs.push({
        id: `task:${t.id}`, source: 'task', title: t.title,
        whenKey: t.due_date ? dayKey(t.due_date) : null,
        priority: PRIORITIES.has(t.priority as ActionPriority) ? (t.priority as ActionPriority) : 'medium',
        href: '/dashboard/todos',
      });
    }
    for (const o of opps ?? []) {
      if (!OPEN_OPP.has(o.status)) continue;
      inputs.push({
        id: `opp:${o.id}`, source: 'opportunity', title: o.title,
        whenKey: o.deadline ? dayKey(o.deadline) : null, href: '/dashboard/signups',
      });
    }
    return rankNextActions(inputs, today);
  }, [events, tasks, opps, today, horizon]);

  const loading = eventsLoading || tasksLoading || oppsLoading;
  const error = eventsError || tasksError || oppsError;
  const refresh = () => { void refreshEvents(); void refreshTasks(); void refreshOpps(); };
  const grouped = useMemo(() => {
    const m = new Map<string, typeof ranked>();
    for (const a of ranked) {
      const arr = m.get(a.bucket) ?? [];
      arr.push(a); m.set(a.bucket, arr);
    }
    return m;
  }, [ranked]);
  const needAttention = attentionCount(ranked);

  async function completeTask(taskId: string) {
    // Was a direct update filtering `id` alone, with no family filter — the same
    // shape §7 keeps finding, and it slipped past the to-dos tranche because that
    // tranche's guard only read `todos-module`. `completeTodo` writes the same
    // two columns, adds the family filter, and reports a row it cannot find
    // instead of succeeding silently.
    //
    // It does NOT reach the household trail: no `complete`/`assign`/`progress`
    // function in this service records one, so the trail carries creates and
    // deletes but not the DOING. Recorded in the ledger rather than half-fixed
    // here — it spans five functions across to-dos and chores.
    const result = await completeTodoAction(taskId, true);
    if (!result.ok) { toastError(result.error); return; }
    journey.complete(); // first clear completes the journey (no-op thereafter)
    success('Nice — one less thing');
  }

  if (loading) return <SkeletonList count={6} />;
  if (error) return <ErrorState message="Could not load next actions. Refresh and try again." onRetry={refresh} />;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title={tr('nextActions.nextBestActions')}
        description="Everything that needs the family, ranked by what matters most right now."
      />

      {ranked.length === 0 ? (
        <EmptyState icon={Sparkles} title={i18nT('nextActions.youreAllCaughtUp')}
          description="No overdue tasks, upcoming events, or closing opportunities need attention. Enjoy it." />
      ) : (
        <>
          <div className="mb-5 flex items-center gap-2 rounded-xl border border-border bg-surface/50 px-4 py-3 text-sm">
            <Target className="h-4 w-4 text-brand-text" />
            {needAttention > 0
              ? <span><span className="font-semibold text-fg">{needAttention}</span> {needAttention === 1 ? 'item needs' : 'items need'} {tr('nextActions.attentionToday')} {ranked.length} {tr('nextActions.totalInYourQueue')}</span>
              : <span><span className="font-semibold text-fg">{ranked.length}</span> {tr('nextActions.upcomingNothingOverdueNicelyAhead')}</span>}
          </div>

          <div className="space-y-6">
            {BUCKET_ORDER.filter((b) => grouped.has(b)).map((bucket) => {
              const items = grouped.get(bucket)!;
              const urgent = bucket === 'overdue';
              return (
                <section key={bucket}>
                  <h2 className={cn('mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide',
                    urgent ? 'text-rose-300' : 'text-muted')}>
                    {urgent && <AlertCircle className="h-3.5 w-3.5" />}
                    {BUCKET_LABELS[bucket]} <span className="opacity-60">· {items.length}</span>
                  </h2>
                  <ul className="space-y-2">
                    {items.map((a) => {
                      const meta = SOURCE_META[a.source];
                      const Icon = meta.icon;
                      const isTask = a.source === 'task';
                      return (
                        <li key={a.id} className={cn('flex items-center gap-3 rounded-xl border bg-surface/50 p-3',
                          urgent ? 'border-rose-500/30' : 'border-border')}>
                          <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg border', meta.cls)}>
                            <Icon className="h-4 w-4" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-fg">{a.title}</p>
                            <p className={cn('text-xs', urgent ? 'text-rose-300' : 'text-muted')}>{meta.label} · {a.reason}</p>
                          </div>
                          {isTask && (
                            <button onClick={() => completeTask(a.id.replace('task:', ''))} aria-label={tr('nextActions.markDone')} title={tr('nextActions.markDone')}
                              className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:border-emerald-500/40 hover:text-emerald-300">
                              <Check className="h-4 w-4" />
                            </button>
                          )}
                          <Link href={a.href} aria-label={tr('nextActions.open')} title={tr('nextActions.open')}
                            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-brand-text">
                            <ArrowRight className="h-4 w-4" />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
