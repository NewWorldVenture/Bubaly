import { getTranslations } from '@/lib/i18n/server';
import type { SignalPrecisionResult } from '@/lib/metric/signal-precision-server';
import { SIGNAL_SOURCES } from '@/lib/metric/signal-precision';

export async function SignalPrecisionCard({ result, retryHref, allFamilies = false }: {
  result: SignalPrecisionResult;
  retryHref: string;
  allFamilies?: boolean;
}) {
  const t = await getTranslations();
  const sourceKey = { family_signals: 'signalPrecision.familySignals', autopilot: 'signalPrecision.autopilot' };
  return (
    <section className="rounded-2xl border border-border bg-surface/50 p-4">
      <h2 className="text-sm font-semibold">{t('signalPrecision.title')}</h2>
      <p className="mt-1 text-xs text-muted">{t(allFamilies ? 'signalPrecision.allFamiliesWindow' : 'signalPrecision.familyWindow')}</p>
      {!result.available ? (
        <div role="alert" className="mt-3 text-sm text-danger">
          <p>{t('signalPrecision.unavailable')}</p>
          <a href={retryHref} className="mt-2 inline-block font-medium underline">{t('signalPrecision.retry')}</a>
        </div>
      ) : result.data.precision === null ? (
        <p className="mt-3 text-sm text-muted">{t('signalPrecision.noDecisions')}</p>
      ) : (
        <>
          <p className="mt-3 text-2xl font-bold tabular-nums">{t('signalPrecision.percent', { value: Math.round(result.data.precision * 100) })}</p>
          <p className="text-xs text-muted">{t('signalPrecision.counts', { accepted: result.data.accepted, decided: result.data.decided })}</p>
          <dl className="mt-3 grid gap-2 sm:grid-cols-2">
            {SIGNAL_SOURCES.map((source) => {
              const item = result.data.bySource[source];
              return <div key={source}>
                <dt className="text-xs font-medium">{t(sourceKey[source])}</dt>
                <dd className="text-xs text-muted">{item.precision === null ? t('signalPrecision.noDecisions') : t('signalPrecision.sourceCounts', {
                  value: Math.round(item.precision * 100), accepted: item.accepted, decided: item.decided,
                })}</dd>
              </div>;
            })}
          </dl>
        </>
      )}
      <p className="mt-3 text-xs text-muted">{t('signalPrecision.definition')}</p>
    </section>
  );
}
