import { getLocaleContext } from '@/lib/i18n/server';
import { translate } from '@/lib/i18n/messages';
import type { AutomaticCaptureResult } from '@/lib/metric/automatic-capture-server';

export async function AutomaticCaptureCard({ result }: { result: AutomaticCaptureResult }) {
  const { locale, messages } = await getLocaleContext();
  const t = (key: string, values?: Record<string, string | number>) => translate(messages, key, values);
  const number = (value: number) => new Intl.NumberFormat(locale.code, { maximumFractionDigits: 1 }).format(value);
  return (
    <section className="rounded-2xl border border-border bg-surface p-5" aria-labelledby="automatic-capture-title">
      <h2 id="automatic-capture-title" className="text-base font-bold">{t('automaticCapture.title')}</h2>
      {!result.ok ? <>
        <p role="status" className="mt-2 text-sm text-muted">{t('automaticCapture.unavailable')}</p>
        <a href="/dashboard/intelligence" className="mt-2 inline-block text-sm font-semibold underline">{t('timeSaved.tryAgain')}</a>
      </>
        : result.data.total === 0 ? <p className="mt-2 text-sm text-muted">{t('automaticCapture.noData')}</p>
          : <>
            <p className="mt-2 text-3xl font-bold tabular-nums">{t('automaticCapture.minimumShare', { percent: number(result.data.minimumPercent!) })}</p>
            <p className="mt-2 text-sm text-muted">{t('automaticCapture.counts', { automatic: number(result.data.automatic), total: number(result.data.total) })}</p>
            <p className="mt-1 text-sm text-muted">{t('automaticCapture.unknown', { unknown: number(result.data.unknown) })}</p>
          </>}
      <p className="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-muted">{t('automaticCapture.methodology')}</p>
    </section>
  );
}
