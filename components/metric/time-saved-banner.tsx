// R11 — the category metric on-surface. Renders "N hours saved this week" with a
// transparent breakdown. A server component (no hooks) so it can translate its
// own copy; Home and the Experience Scorecard both render it.
//
// THREE states, and they are three different facts:
//   * unavailable — a count could not be read. Says so, and offers a retry.
//     Never 0, never hidden: an outage must not read as a quiet week.
//   * nothing handled yet — hides.
//   * handled — the number, from `loadTimeSaved` and nowhere else.
import { Clock } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import type { TimeSavedResult } from '@/lib/metric/time-saved';

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
    ? t('timeSaved.nHours', { hours: data.hours })
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
          <p className="mt-0.5 text-xs text-muted">{t('timeSaved.timeYouDidntSpendOnFamilyAdmin')}</p>
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
