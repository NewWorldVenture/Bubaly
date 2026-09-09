'use client';

import { useEffect, useId, useState } from 'react';
import { useApp } from '@/components/app/app-context';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { loadFamilyValueComparisonAction, type FamilyValueSnapshot } from '@/app/(app)/dashboard/billing/value-comparison-actions';
import { compareEstimatedTimeValue, DEFAULT_HOURLY_VALUE_USD, ESTIMATED_MINUTES_PER_COMPLETED_RUN, type FamilyValueResult } from '@/lib/metric/value';

export function ValueComparisonSummary({ result, onRetry }: { result: FamilyValueResult | null; onRetry: () => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const inputId = useId();
  const [hourlyInput, setHourlyInput] = useState(String(DEFAULT_HOURLY_VALUE_USD));
  if (result?.state === 'ineligible') return null;
  const hourly = hourlyInput.trim() === '' ? NaN : Number(hourlyInput);
  const minutes = result?.state === 'available' ? result.completedRuns * ESTIMATED_MINUTES_PER_COMPLETED_RUN : 0;
  const comparison = result?.state === 'available' ? compareEstimatedTimeValue(minutes, hourly, result.annualListCents) : null;
  const currency = (cents: number) => new Intl.NumberFormat(locale.code, { style: 'currency', currency: 'USD' }).format(cents / 100);
  return (
    <section className="rounded-xl border border-border bg-surface/30 p-4" aria-live="polite">
      <h3 className="text-sm font-semibold">{t('valueComparison.heading')}</h3>
      {result === null ? <p className="mt-2 text-sm text-muted" role="status">{t('states.loading')}</p>
        : result.state === 'unavailable' ? <div className="mt-2 text-sm" role="alert">
          <p>{t('valueComparison.unavailable')}</p>
          <button type="button" onClick={onRetry} className="focus-ring mt-1 min-h-11 text-brand-text underline">{t('timeSaved.tryAgain')}</button>
        </div> : <>
          <p className="mt-2 text-sm text-muted">{t('valueComparison.recorded', { count: result.completedRuns, minutes })}</p>
          {result.undatedCompletedRuns > 0 && <p className="mt-2 text-xs text-muted">{t('valueComparison.undated', { count: result.undatedCompletedRuns })}</p>}
          <label htmlFor={inputId} className="mt-3 block text-xs font-medium">{t('valueComparison.hourlyLabel')}</label>
          <input id={inputId} type="number" min="0" max="1000" step="0.01" value={hourlyInput}
            onChange={(event) => setHourlyInput(event.target.value)} aria-invalid={!comparison}
            className="focus-ring mt-1 min-h-11 w-36 rounded-lg border border-border bg-surface px-3 text-sm" />
          {comparison ? <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <div><dt className="text-xs text-muted">{t('valueComparison.estimatedValue')}</dt><dd className="mt-1 text-xl font-bold">{currency(comparison.estimatedValueCents)}</dd></div>
            <div><dt className="text-xs text-muted">{t('valueComparison.planShare')}</dt><dd className="mt-1 text-xl font-bold">{currency(comparison.periodListCents)}</dd></div>
            <div><dt className="text-xs text-muted">{t('valueComparison.ratio')}</dt><dd className="mt-1 text-xl font-bold">{t('valueComparison.multiple', { ratio: new Intl.NumberFormat(locale.code, { maximumFractionDigits: 1 }).format(comparison.ratio) })}</dd></div>
          </dl> : <p className="mt-2 text-sm text-muted" role="alert">{t('valueComparison.invalidHourly')}</p>}
          <p className="mt-3 text-xs text-muted">{t('valueComparison.assumptions', { minutes: ESTIMATED_MINUTES_PER_COMPLETED_RUN })}</p>
          <details className="mt-2 text-xs text-muted">
            <summary className="focus-ring cursor-pointer py-2">{t('valueComparison.methodHeading')}</summary>
            <p>{t('valueComparison.method')}</p>
            {result.undatedCompletedRuns === 0 && <p className="mt-2">{t('valueComparison.undated', { count: 0 })}</p>}
            <p className="mt-2">{t('valueComparison.priceMethod')}</p>
          </details>
        </>}
    </section>
  );
}

/** Reuses a server-rendered Home snapshot; billing loads through the session-only action. */
export function FamilyValueComparison({ initial }: { initial?: FamilyValueSnapshot } = {}) {
  const { familyId } = useApp();
  const [snapshot, setSnapshot] = useState<FamilyValueSnapshot | null>(initial ?? null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (retry === 0 && initial?.familyId === familyId) {
      setSnapshot(initial);
      return;
    }
    let current = true;
    setSnapshot(null);
    loadFamilyValueComparisonAction().then((value) => {
      if (current) setSnapshot({ familyId, result: value.familyId === familyId ? value.result : { state: 'unavailable' } });
    }).catch(() => {
      if (current) setSnapshot({ familyId, result: { state: 'unavailable' } });
    });
    return () => { current = false; };
  }, [familyId, retry, initial]);
  return <ValueComparisonSummary result={snapshot?.familyId === familyId ? snapshot.result : null} onRetry={() => setRetry((value) => value + 1)} />;
}
