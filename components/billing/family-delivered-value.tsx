'use client';

import { useEffect, useState } from 'react';
import { useApp } from '@/components/app/app-context';
import { useTranslations } from '@/components/i18n/locale-provider';
import { loadFamilyDeliveredValueAction, type FamilyDeliveredValue as ValueSnapshot } from '@/app/(app)/dashboard/billing/value-actions';
import type { TimeSavedResult } from '@/lib/metric/time-saved';

/** Shared by purchase surfaces; estimates never become measured time or cash savings. */
export function DeliveredValueSummary({ result, onRetry }: { result: TimeSavedResult | null; onRetry: () => void }) {
  const t = useTranslations();
  return (
    <section className="rounded-xl border border-brand/20 bg-brand/5 p-4" aria-live="polite">
      <h3 className="text-sm font-semibold">{t('billingValue.heading')}</h3>
      {result === null ? (
        <p className="mt-2 text-sm text-muted" role="status">{t('states.loading')}</p>
      ) : !result.available ? (
        <div role="alert" className="mt-2 text-sm">
          <p>{t('timeSaved.couldNotReadWhatBubalyHandled')}</p>
          <button type="button" onClick={onRetry} className="focus-ring mt-1 inline-flex min-h-11 items-center text-brand-text underline underline-offset-4">
            {t('timeSaved.tryAgain')}
          </button>
        </div>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-4">
            <div>
              <dt className="text-xs text-muted">{t('billingValue.handledLabel')}</dt>
              <dd className="mt-1 text-xl font-bold">{result.data.actions}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('billingValue.estimatedTimeLabel')}</dt>
              <dd className="mt-1 text-xl font-bold">{result.data.minutes < 60
                ? t('timeSaved.nMin', { minutes: result.data.minutes })
                : result.data.hours === 1 ? t('timeSaved.oneHour') : t('timeSaved.nHours', { hours: result.data.hours })}</dd>
            </div>
          </dl>
          {result.data.actions === 0 && <p className="mt-2 text-xs text-muted">{t('billingValue.noHandledYet')}</p>}
          <p className="mt-2 text-xs text-muted">{t('billingValue.estimateNote')}</p>
        </>
      )}
    </section>
  );
}

/** Mount only when visible. The family marker also hides a stale response immediately on switching households. */
export function FamilyDeliveredValue() {
  const { familyId } = useApp();
  const [snapshot, setSnapshot] = useState<ValueSnapshot | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setSnapshot(null);
    void loadFamilyDeliveredValueAction().then((value) => {
      if (current) setSnapshot({ familyId, result: value.familyId === familyId ? value.result : { available: false } });
    }).catch(() => {
      if (current) setSnapshot({ familyId, result: { available: false } });
    });
    return () => { current = false; };
  }, [familyId, retry]);

  return <DeliveredValueSummary result={snapshot?.familyId === familyId ? snapshot.result : null} onRetry={() => setRetry((value) => value + 1)} />;
}
