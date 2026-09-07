// The run history (M35): one chronological list of everything Bubaly has been
// asked to do for this family — newest first, filterable by where a run is
// (active, waiting on a person, done, problems) — where before the history was
// split across the per-run page, the family-automation page and the two Home
// cards. Reachable from /dashboard/concierge and the Home "Working on" and
// "Completed by Bubaly" headers; deliberately NOT in the shared sidebar.
//
// Reads through the same boundary as the run page: the caller's own client
// (`listRuns`, `loadRunEvidence`), every statement family-scoped, and a failed
// read shown as a failure with a retry — a list that came back empty because
// the read failed would look like a family Bubaly has never worked for. What
// renders is the `RunHistoryItem` read model (lib/ai/runs/history.ts), never
// the raw rows, so the lease, result and metadata columns stay on the server.
//
// TODO(M6 undo): reversing a run's writes from here needs a migration
// (`ai_plan_steps.undone_at/undone_by`, `ai_tool_calls.created_refs jsonb`,
// an `undone` ai_run_events type), so this page offers no Undo rather than an
// inert one. TODO(M35 dead-letter): `ai_tool_calls` rows a dead worker left in
// 'reserved' are reconciled only at the run level by 0263; marking them
// 'unknown' with a timeline note needs a follow-up to `claim_ai_runs`.
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ChevronLeft, ChevronRight, History } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { assertAIAccess } from '@/lib/server/ai-access';
import { scopeFromUserContext } from '@/lib/services/scope';
import { listRuns } from '@/lib/ai/runs/store';
import { loadRunEvidence } from '@/lib/ai/runs/evidence';
import {
  parseRunHistoryCursor, parseRunHistoryFilter, runHistoryItems, RUN_HISTORY_FILTERS, RUN_HISTORY_FILTER_STATES, RUN_HISTORY_PAGE_SIZE,
  type RunHistoryFilter, type RunHistoryItem, type RunHistoryRunRow,
} from '@/lib/ai/runs/history';
import { sourcesLine } from '@/lib/ai/tool-domains';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import { ErrorState } from '@/components/ui/states';
import { StatusBadge } from '@/components/concierge/status-badge';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Run history' };
export const dynamic = 'force-dynamic';

const RUNS_PATH = '/dashboard/concierge/runs';

/** The catalogue key for each filter chip; the English stays beside it so the table reads. */
const FILTER_LABELS: Readonly<Record<RunHistoryFilter, { label: string; labelKey: string }>> = {
  all: { label: 'All', labelKey: 'runHistory.filterAll' },
  active: { label: 'In progress', labelKey: 'runHistory.filterActive' },
  waiting: { label: 'Waiting on you', labelKey: 'runHistory.filterWaiting' },
  done: { label: 'Done', labelKey: 'runHistory.filterDone' },
  problems: { label: 'Problems', labelKey: 'runHistory.filterProblems' },
};

function historyHref(filter: RunHistoryFilter, before?: string | null): string {
  const params = new URLSearchParams();
  if (filter !== 'all') params.set('state', filter);
  if (before) params.set('before', before);
  const query = params.toString();
  return query ? `${RUNS_PATH}?${query}` : RUNS_PATH;
}

async function Unavailable({ message, retryHref }: { message: string; retryHref: string }) {
  const t = await getTranslations();
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <Link href="/dashboard/concierge" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted hover:text-fg focus-ring">
        <ArrowLeft className="h-4 w-4" aria-hidden /> {t('runHistory.askBubaly')}
      </Link>
      <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t('runHistory.runHistory')}</h1>
      <ErrorState message={message} />
      <Link href={retryHref} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-text underline focus-ring">{t('states.tryAgain')}</Link>
    </div>
  );
}

function whenLabel(iso: string, locale: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
}

export default async function RunHistoryPage({ searchParams }: { searchParams: Promise<{ state?: string; before?: string }> }) {
  const t = await getTranslations();
  const { locale } = await getLocaleContext();
  const params = await searchParams;
  const filter = parseRunHistoryFilter(params.state);
  const before = parseRunHistoryCursor(params.before);
  const selfHref = historyHref(filter, before);

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const access = await assertAIAccess(ctx, { db: supabase });
  if (!access.ok) {
    if (access.status === 404) notFound();
    return <Unavailable message={access.error} retryHref={selfHref} />;
  }

  // One row past the page tells us whether an "Older" link is honest.
  const listed = await listRuns(scopeFromUserContext(ctx, supabase), {
    states: RUN_HISTORY_FILTER_STATES[filter],
    before,
    limit: RUN_HISTORY_PAGE_SIZE + 1,
  });
  if (!listed.ok) return <Unavailable message={listed.error} retryHref={selfHref} />;
  const hasOlder = listed.data.length > RUN_HISTORY_PAGE_SIZE;
  const rows = listed.data.slice(0, RUN_HISTORY_PAGE_SIZE) as RunHistoryRunRow[];

  const evidence = await loadRunEvidence(supabase, familyId, rows);
  if (!evidence.ok) return <Unavailable message={evidence.error} retryHref={selfHref} />;

  const items: RunHistoryItem[] = runHistoryItems(rows, evidence.data);
  const olderHref = hasOlder && items.length ? historyHref(filter, items[items.length - 1].createdAt) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-6 pb-28">
      <Link href="/dashboard/concierge" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted hover:text-fg focus-ring">
        <ArrowLeft className="h-4 w-4" aria-hidden /> {t('runHistory.askBubaly')}
      </Link>

      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <History className="h-5 w-5 text-brand-text" aria-hidden />
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl lg:text-3xl">{t('runHistory.runHistory')}</h1>
        </div>
        <p className="text-sm text-muted">{t('runHistory.everythingBubalyHasBeenAsked')}</p>
      </header>

      <nav aria-label={t('runHistory.filterRuns')} className="flex flex-wrap gap-2">
        {RUN_HISTORY_FILTERS.map((f) => (
          <Link
            key={f}
            href={historyHref(f)}
            aria-current={f === filter ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-11 items-center rounded-full border px-3.5 text-sm font-medium transition focus-ring',
              f === filter ? 'border-brand/40 bg-brand/15 text-brand-text' : 'border-border bg-surface/40 text-muted hover:bg-elevated hover:text-fg',
            )}
          >
            {t(FILTER_LABELS[f].labelKey)}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
          {before ? t('runHistory.noOlderRunsHere') : filter === 'all' ? t('runHistory.nothingYetTheFirstThing') : t('runHistory.noRunsMatchThisFilter')}
        </p>
      ) : (
        <ol className="space-y-2" aria-label={t('runHistory.runs')}>
          {items.map((item) => {
            const source = sourcesLine(item.sources, t);
            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className="block rounded-2xl border border-border bg-surface/40 px-4 py-3 transition hover:bg-elevated focus-ring"
                  data-run-state={item.state}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge state={item.state} />
                    {item.startedByRoutine && <span className="text-xs text-muted">{t('dashboardConciergeRuns.startedByARoutine')}</span>}
                    <span className="ml-auto text-xs tabular-nums text-muted">
                      <time dateTime={item.finishedAt ?? item.createdAt}>{whenLabel(item.finishedAt ?? item.createdAt, locale.code)}</time>
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm font-semibold text-fg">{item.title ?? t('runHistory.aRequestFromYourFamily')}</p>
                  {item.detail && <p className="mt-0.5 text-xs text-muted">{item.detail}</p>}
                  {item.error && <p className="mt-0.5 text-xs text-danger">{item.error}</p>}
                  {source && (
                    <p className="mt-1 text-xs text-muted" data-testid="run-source">
                      <span className="sr-only">{t('completedByBubaly.doneWith')} </span>
                      <span className="font-medium text-fg/70">{source}</span>
                    </p>
                  )}
                  {item.reason && (
                    <p className="mt-0.5 text-xs italic text-muted" data-testid="run-reason">
                      <span className="sr-only">{t('completedByBubaly.why')} </span>
                      {item.reason}
                    </p>
                  )}
                </Link>
              </li>
            );
          })}
        </ol>
      )}

      {(before || olderHref) && (
        <nav aria-label={t('runHistory.moreRuns')} className="flex items-center justify-between gap-3">
          {before ? (
            <Link href={historyHref(filter)} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-text hover:underline focus-ring">
              <ChevronLeft className="h-4 w-4" aria-hidden /> {t('runHistory.newest')}
            </Link>
          ) : <span />}
          {olderHref && (
            <Link href={olderHref} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-text hover:underline focus-ring">
              {t('runHistory.older')} <ChevronRight className="h-4 w-4" aria-hidden />
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
