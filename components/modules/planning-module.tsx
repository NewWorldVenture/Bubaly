'use client';

// Autonomous Prep Plans — "prepare, don't notify". Coordinated, timed plans for
// what's on the horizon (trips, birthdays, expiring docs), generated from real
// family data by the pure engine + server action. Plans + steps are real Supabase
// rows; checking steps off and dismissing plans persist. 100% Supabase + realtime.
import { useMemo, useState } from 'react';
import { CalendarClock, Sparkles, Check, X, Plane, Cake, FileText, GraduationCap, CalendarDays } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import { generatePrepPlansAction } from '@/app/(app)/dashboard/prep-plans/prep-actions';
import type { Tables } from '@/lib/database.types';

type Plan = Tables<'prep_plans'>;
type Step = Tables<'prep_plan_steps'>;

const KIND_ICON: Record<string, typeof Plane> = {
  trip: Plane, birthday: Cake, doc_expiry: FileText, school_start: GraduationCap, event: CalendarDays,
};
const URGENCY_STYLE: Record<string, string> = {
  now: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
  soon: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  later: 'text-muted border-border',
};
const URGENCY_LABEL: Record<string, string> = { now: 'Start now', soon: 'Coming up', later: 'On the horizon' };

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr + 'T00:00:00Z').getTime();
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.round((target - today) / 86_400_000);
}

export function PlanningModule() {
  const { familyId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: plans, loading: plansLoading, error: plansError, refresh: refreshPlans } = useRealtimeQuery<Plan>({
    table: 'prep_plans', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('prep_plans').select('*').eq('family_id', familyId).eq('status', 'active').order('target_date'),
  });
  const { data: steps, loading: stepsLoading, error: stepsError, refresh: refreshSteps } = useRealtimeQuery<Step>({
    table: 'prep_plan_steps', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('prep_plan_steps').select('*').eq('family_id', familyId).order('sort_order'),
  });
  const loading = plansLoading || stepsLoading;
  const error = plansError || stepsError;
  const refresh = () => { void refreshPlans(); void refreshSteps(); };

  const stepsByPlan = useMemo(() => {
    const m = new Map<string, Step[]>();
    for (const s of steps ?? []) (m.get(s.plan_id) ?? m.set(s.plan_id, []).get(s.plan_id)!).push(s);
    return m;
  }, [steps]);

  const [generating, setGenerating] = useState(false);
  async function generate() {
    setGenerating(true);
    const res = await generatePrepPlansAction();
    setGenerating(false);
    if (!res.ok) { toastError(res.error ?? 'Could not generate plans'); return; }
    if (res.plans === 0) { toastError('Nothing on the horizon yet — add a trip, birthday, or document date.'); return; }
    success(`${res.plans} prep ${res.plans === 1 ? 'plan' : 'plans'} ready`);
  }

  async function toggleStep(step: Step) {
    const sb = createClient();
    const { error } = await sb.from('prep_plan_steps').update({ is_done: !step.is_done }).eq('id', step.id);
    if (error) toastError(describeDbError(error));
  }
  async function dismiss(planId: string) {
    const sb = createClient();
    const { error } = await sb.from('prep_plans').update({ status: 'dismissed' }).eq('id', planId);
    if (error) { toastError(describeDbError(error)); return; }
    success('Plan dismissed');
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Prep Plans"
        description="The AI looks ahead and prepares — coordinated, timed plans for what's coming, so nothing is a last-minute scramble."
        action={<Button onClick={generate} disabled={generating}><Sparkles className="size-4" /> {generating ? 'Looking ahead…' : 'Generate plans'}</Button>}
      />

      {loading ? (
        <SkeletonList count={4} />
      ) : error ? (
        <ErrorState message="Could not load prep plans. Refresh and try again." onRetry={refresh} />
      ) : (plans ?? []).length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <CalendarClock className="mx-auto mb-3 size-8 text-muted" />
          <h3 className="mb-1 text-base font-semibold">Nothing to prep — yet</h3>
          <p className="mx-auto mb-4 max-w-md text-sm text-muted">
            Add a trip, a birthday, or a document with an expiry date, then generate plans. The
            assistant works backward from each date into timed, ordered steps.
          </p>
          <Button onClick={generate} disabled={generating}><Sparkles className="size-4" /> {generating ? 'Looking ahead…' : 'Generate plans'}</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {(plans ?? []).map((p) => {
            const Icon = KIND_ICON[p.signal_kind] ?? CalendarDays;
            const planSteps = stepsByPlan.get(p.id) ?? [];
            const done = planSteps.filter((s) => s.is_done).length;
            const d = daysUntil(p.target_date);
            return (
              <div key={p.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 items-center justify-center rounded-lg bg-muted/10"><Icon className="size-4" /></span>
                    <div>
                      <h3 className="font-semibold">{p.title}</h3>
                      <p className="text-xs text-muted">
                        {d === 0 ? 'today' : d > 0 ? `in ${d} day${d === 1 ? '' : 's'}` : `${-d} day${d === -1 ? '' : 's'} ago`}
                        {planSteps.length > 0 && ` · ${done}/${planSteps.length} done`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn('rounded-full border px-2 py-0.5 text-[10px]', URGENCY_STYLE[p.urgency] ?? URGENCY_STYLE.later)}>{URGENCY_LABEL[p.urgency] ?? p.urgency}</span>
                    <button onClick={() => dismiss(p.id)} className="rounded-full p-1 text-muted hover:bg-muted/10" aria-label="Dismiss plan"><X className="size-4" /></button>
                  </div>
                </div>
                {planSteps.length > 0 && (
                  <ul className="mt-3 space-y-1.5 border-t border-border pt-3">
                    {planSteps.map((s) => (
                      <li key={s.id} className="flex items-center gap-2.5 text-sm">
                        <button
                          onClick={() => toggleStep(s)}
                          className={cn('flex size-5 shrink-0 items-center justify-center rounded border', s.is_done ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300' : 'border-border')}
                          aria-label={s.is_done ? 'Mark not done' : 'Mark done'}
                        >
                          {s.is_done && <Check className="size-3.5" />}
                        </button>
                        <a href={s.href ?? '#'} className={cn('flex-1 hover:underline', s.is_done && 'text-muted line-through')}>{s.label}</a>
                        {s.due_date && <span className="text-[11px] text-muted">by {s.due_date.slice(5)}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
