'use client';

// §16 "Bubaly Is Working On": every run that is not finished, as one line each
// — "Planning next week's meals — 7 of 9 steps complete", "Preparing beach
// vacation — waiting for your OK" — linking to its run page.
//
// The server page renders the list first (so it is correct on a cold load and
// after a refresh), then this component keeps it live from Realtime: step rows
// change as the executor works, run rows change when a run parks, pauses or
// finishes. Both subscriptions rebuild the SAME read model through the pure
// `workingRunsFrom`, so what the browser shows a minute later is what the
// server would render if asked again.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Sparkles } from 'lucide-react';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import type { SupabaseBrowser } from '@/lib/supabase/types';
import { WORKING_RUN_STATES, workingRunsFrom, type WorkingRun, type WorkingRunRow, type WorkingStepRow } from '@/lib/home/today';
import { StatusBadge } from './status-badge';
import { useTranslations } from '@/components/i18n/locale-provider';

const RUN_COLUMNS = 'id, summary, state, plan_id, updated_at, created_at';

/** The same two reads the server pages do, so the live list and the first paint agree. */
async function fetchWorking(supabase: SupabaseBrowser, familyId: string): Promise<{ data: WorkingRun[] | null; error: { message: string } | null }> {
  const { data: runs, error } = await supabase
    .from('family_automation_runs').select(RUN_COLUMNS)
    .eq('family_id', familyId).in('state', [...WORKING_RUN_STATES])
    .order('updated_at', { ascending: false }).limit(8);
  if (error) return { data: null, error };
  const runRows = (runs ?? []) as WorkingRunRow[];
  const planIds = runRows.map((r) => r.plan_id).filter((id): id is string => !!id);
  let stepRows: WorkingStepRow[] = [];
  if (planIds.length) {
    const { data: steps, error: stepError } = await supabase
      .from('ai_plan_steps').select('plan_id, status').eq('family_id', familyId).in('plan_id', planIds);
    if (stepError) return { data: null, error: stepError };
    stepRows = (steps ?? []) as WorkingStepRow[];
  }
  return { data: workingRunsFrom(runRows, stepRows), error: null };
}

export function WorkingOn({
  familyId, initial, historyHref, className,
}: {
  familyId: string;
  initial: WorkingRun[];
  /** Where the whole run history lives (M35); rendered as an "All runs" link in the header. */
  historyHref?: string | null;
  className?: string;
}) {
  const t = useTranslations();
  const [rows, setRows] = useState<WorkingRun[]>(initial);

  const byStep = useRealtimeQuery<WorkingRun>({
    table: 'ai_plan_steps', familyId, deps: [familyId, 'working'],
    fetcher: (supabase) => fetchWorking(supabase, familyId),
  });
  const byRun = useRealtimeQuery<WorkingRun>({
    table: 'family_automation_runs', familyId, deps: [familyId, 'working'],
    fetcher: (supabase) => fetchWorking(supabase, familyId),
  });

  // Whichever subscription fetched most recently holds the truth: both build
  // the whole list, so last-write-wins is correct rather than a race.
  useEffect(() => { if (!byStep.loading && !byStep.error) setRows(byStep.data); }, [byStep.data, byStep.loading, byStep.error]);
  useEffect(() => { if (!byRun.loading && !byRun.error) setRows(byRun.data); }, [byRun.data, byRun.loading, byRun.error]);

  return (
    <section aria-labelledby="working-on-heading" className={className}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand-text" aria-hidden />
          <h2 id="working-on-heading" className="text-sm font-semibold uppercase tracking-wide text-muted">{t('workingOn.bubalyIsWorkingOn')}</h2>
        </div>
        {historyHref && (
          <Link href={historyHref} className="flex min-h-11 items-center gap-0.5 text-xs font-semibold text-brand-text hover:underline focus-ring">
            {t('workingOn.allRuns')} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted">
          {t('workingOn.nothingInProgressAskForSomething')}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((run) => (
            <li key={run.id}>
              <Link
                href={run.href}
                className="flex min-h-[44px] items-center gap-3 rounded-2xl border border-border bg-surface/40 px-4 py-3 transition hover:bg-elevated focus-ring"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-fg">{run.title}</p>
                  <p className="truncate text-xs text-muted">{run.detail}</p>
                </div>
                <StatusBadge state={run.state} className="hidden sm:inline-flex" />
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
