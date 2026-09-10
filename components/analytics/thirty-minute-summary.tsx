import { Card } from '@/components/ui/card';

export function ThirtyMinuteSummary({ kind, rate, within, timed, untimed, t }: {
  kind: 'setup' | 'activation'; rate: number | null; within: number; timed: number; untimed: number;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return <Card className="p-5">
    <h2 className="text-sm font-semibold">{t(kind === 'setup' ? 'thirtyMinute.setupTitle' : 'thirtyMinute.activationTitle')}</h2>
    <p className="mt-2 text-3xl font-bold tabular-nums">{rate === null ? '—' : `${Math.round(rate * 10) / 10}%`}</p>
    <p className="mt-2 text-sm text-muted">{timed === 0 ? t('thirtyMinute.noTiming') : t('thirtyMinute.sample', { within, timed })}</p>
    {untimed > 0 && <p className="mt-1 text-sm text-muted">{t('thirtyMinute.missing', { count: untimed })}</p>}
    <p className="mt-2 text-xs text-muted">{t(kind === 'setup' ? 'thirtyMinute.setupMethod' : 'thirtyMinute.activationMethod')}</p>
  </Card>;
}
