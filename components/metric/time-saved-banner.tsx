// Modeled planning time for dated recorded completed plans. Missing-date
// coverage remains visible even when the measured subset is empty.
import { Clock } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import type { TimeSavedResult } from '@/lib/metric/time-saved';
import { MODELED_MINUTES_PER_COMPLETED_PLAN } from '@/lib/metric/completed-plans-model';

export async function TimeSavedBanner({ result, retryHref }: { result: TimeSavedResult; retryHref: string }) {
  const t = await getTranslations();

  if (!result.available) {
    return (
      <section role="alert" className="rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm sm:p-5">
        <p className="font-semibold text-danger">{t('timeSaved.couldNotReadWhatBubalyHandled')}</p>
        <a href={retryHref} className="mt-2 inline-block font-medium text-danger underline">
          {t('timeSaved.tryAgain')}
        </a>
      </section>
    );
  }

  const data = result.data;
  if (!data.show) return null;
  const big = data.hours >= 1
    ? (data.hours === 1 ? t('timeSaved.oneHour') : t('timeSaved.nHours', { hours: data.hours }))
    : t('timeSaved.nMin', { minutes: data.minutes });

  return (
    <section className="rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/[0.09] to-surface/40 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-500/15 text-emerald-500">
          <Clock className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-bold leading-tight">
            {t('timeSaved.savedThisWeek', { amount: big })}
            <span className="ml-2 align-middle text-xs font-medium text-muted">
              {t('timeSaved.nThingsHandledForYou', { count: data.actions })}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-muted">{t('timeSaved.timeYouDidntSpendOnFamilyAdmin', { minutes: MODELED_MINUTES_PER_COMPLETED_PLAN })}</p>
          <p className="mt-1 text-xs text-muted">{t('timeSaved.undatedCompletedPlans', { count: data.undatedCompletedRuns })}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {data.rows.map((r) => (
              <span key={r.kind} className="rounded-full border border-border bg-surface/60 px-2.5 py-1 text-xs text-muted">
                <span className="font-semibold text-fg">{r.count}</span> {t(r.labelKey)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
