// §16 "Completed By Bubaly": recent outcomes — finished runs and the specialist
// agents' completed actions — as a short list of what got done, each linking
// to where the result lives. No hooks: the server page renders it from rows it
// already has, and a partial run is labelled as partial rather than dressed up.
//
// M6: each row also says WHICH tool acted and WHY, from persisted state only —
// the run's `ai_tool_calls`/`ai_plan_steps` and the plan's `reasoning_summary`
// (lib/home/today.ts `runSources`/`runReason`). A row those tables say nothing
// about shows neither, rather than a plausible guess.
//
// This section is a CLAIM ("Bubaly finished these"), so a failed read is
// shown as a failure with a way to retry — never as "nothing finished yet".
import Link from 'next/link';
import { getTranslations } from '@/lib/i18n/server';
import { CheckCircle2, ChevronRight, AlertTriangle } from 'lucide-react';
import type { CompletedItem } from '@/lib/home/today';
import { sourcesLine } from '@/lib/ai/tool-domains';
import { ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';

function whenLabel(iso: string, yesterday: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return yesterday;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export async function CompletedByBubaly({
  items, error, historyHref, retryHref, className,
}: {
  items: CompletedItem[];
  /** The read failure to show instead of the list, when the ledger could not be read. */
  error?: string | null;
  /** Where the whole run history lives; rendered as an "All runs" link in the header. */
  historyHref?: string | null;
  /** The page this section sits on, so a failed read offers a retry rather than a shrug. */
  retryHref?: string | null;
  className?: string;
}) {
  const t = await getTranslations();
  return (
    <section aria-labelledby="completed-by-heading" className={className}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
          <h2 id="completed-by-heading" className="text-sm font-semibold uppercase tracking-wide text-muted">{t('completedByBubaly.completedByBubaly')}</h2>
        </div>
        {historyHref && (
          <Link href={historyHref} className="flex min-h-11 items-center gap-0.5 text-xs font-semibold text-brand-text hover:underline focus-ring">
            {t('completedByBubaly.allRuns')} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        )}
      </div>
      {error ? (
        <div className="space-y-2">
          <ErrorState message={error} />
          {retryHref && (
            <Link href={retryHref} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-text underline focus-ring">
              {t('states.tryAgain')}
            </Link>
          )}
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted">{t('completedByBubaly.nothingFinishedYetTheFirst')}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => {
            const source = sourcesLine(item.sources, t);
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="flex min-h-[44px] items-center gap-3 rounded-xl border border-border/60 bg-surface/20 px-4 py-2.5 transition hover:bg-elevated focus-ring"
                >
                  {item.partial
                    ? <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-label={t('completedByBubaly.partlyDone')} />
                    : <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />}
                  <div className="min-w-0 flex-1">
                    <p className={cn('truncate text-sm', item.partial ? 'text-fg' : 'text-fg/90')}>{item.title}</p>
                    {item.detail && <p className="truncate text-xs text-muted">{item.detail}</p>}
                    {source && (
                      <p className="truncate text-xs text-muted" data-testid="completed-source">
                        <span className="sr-only">{t('completedByBubaly.doneWith')} </span>
                        <span className="font-medium text-fg/70">{source}</span>
                      </p>
                    )}
                    {item.reason && (
                      <p className="truncate text-xs italic text-muted" data-testid="completed-reason">
                        <span className="sr-only">{t('completedByBubaly.why')} </span>
                        {item.reason}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-muted">{whenLabel(item.at, t('completedByBubaly.yesterday'))}</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
