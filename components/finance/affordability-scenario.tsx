'use client';

// "Can we afford it?" — the Family CFO's one-question form. The person names
// a commitment (a one-off or a recurring one) and Bubaly tries it against the
// WHOLE 12-week forecast — bills, goal set-asides, trips, moves, projects,
// subscriptions — not one budget category. The answer is the lowest projected
// balance before and after, and a verdict against the buffer. Nothing is
// saved; the server action reads and computes only.
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2, FlaskConical, Loader2, XCircle } from 'lucide-react';
import { assessAffordabilityAction } from '@/app/(app)/dashboard/family-cfo/actions';
import { money, pretty, type AffordabilityResult, type AffordabilityVerdict, type ScenarioRecurrence } from '@/lib/finance/timeline';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

const VERDICT: Record<AffordabilityVerdict, { labelKey: string; icon: typeof CheckCircle2; chip: string; ring: string }> = {
  ok: { labelKey: 'affordabilityScenario.verdictOk', icon: CheckCircle2, chip: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400', ring: 'border-emerald-500/30' },
  tight: { labelKey: 'affordabilityScenario.verdictTight', icon: AlertTriangle, chip: 'bg-amber-500/12 text-amber-600 dark:text-amber-400', ring: 'border-amber-500/30' },
  breaches: { labelKey: 'affordabilityScenario.verdictBreaches', icon: XCircle, chip: 'bg-rose-500/12 text-rose-600 dark:text-rose-400', ring: 'border-rose-500/30' },
};

const RECURRENCES: { value: ScenarioRecurrence; labelKey: string }[] = [
  { value: 'once', labelKey: 'affordabilityScenario.once' },
  { value: 'weekly', labelKey: 'affordabilityScenario.everyWeek' },
  { value: 'monthly', labelKey: 'affordabilityScenario.everyMonth' },
  { value: 'yearly', labelKey: 'affordabilityScenario.everyYear' },
];

/** Two weeks out, as YYYY-MM-DD — a sensible default for "when would it land?". */
function defaultDate(): string {
  return new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
}

const INPUT = 'mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-base text-fg sm:text-sm';

export function AffordabilityScenario({ buffer }: { buffer: number }) {
  const t = useTranslations();
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [recurrence, setRecurrence] = useState<ScenarioRecurrence>('once');
  const [result, setResult] = useState<AffordabilityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = () => {
    const amountDollars = parseFloat(amount);
    if (!Number.isFinite(amountDollars) || amountDollars <= 0) { setError(t('affordabilityScenario.enterAnAmountAboveZero')); setResult(null); return; }
    if (!date) { setError(t('affordabilityScenario.pickTheDateItWouldLand')); setResult(null); return; }
    setError(null);
    start(async () => {
      try {
        const res = await assessAffordabilityAction({ label, amountDollars, date, recurrence });
        if (res.ok) { setResult(res.result); setError(null); }
        else { setResult(null); setError(res.error); }
      } catch {
        setResult(null);
        setError(t('affordabilityScenario.couldNotCheckThatTryAgain'));
      }
    });
  };

  const v = result ? VERDICT[result.verdict] : null;

  return (
    <section className="rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/[0.06] to-surface/40 p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand/15 text-brand-text"><FlaskConical className="h-4 w-4" /></span>
        <div>
          <h2 className="text-sm font-semibold">{t('affordabilityScenario.canWeAffordIt')}</h2>
          <p className="text-xs text-muted">{t('affordabilityScenario.tryACommitmentAgainstThe', { buffer: money(buffer) })}</p>
        </div>
      </div>

      <form
        className="grid gap-2.5 sm:grid-cols-2"
        onSubmit={(e) => { e.preventDefault(); run(); }}
      >
        <label className="text-xs font-medium text-muted">{t('affordabilityScenario.what')}
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('affordabilityScenario.newCarSeat')} className={INPUT} />
        </label>
        <label className="text-xs font-medium text-muted">{t('affordabilityScenario.amount')}
          <input type="number" inputMode="decimal" min={0} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="400" className={INPUT} />
        </label>
        <label className="text-xs font-medium text-muted">{t('affordabilityScenario.when')}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT} />
        </label>
        <label className="text-xs font-medium text-muted">{t('affordabilityScenario.repeats')}
          <select value={recurrence} onChange={(e) => setRecurrence(e.target.value as ScenarioRecurrence)} className={INPUT}>
            {RECURRENCES.map((r) => <option key={r.value} value={r.value}>{t(r.labelKey)}</option>)}
          </select>
        </label>
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/90 disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
            {t('affordabilityScenario.checkIt')}
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-300">{error}</p>
      )}

      {result && v && (
        <div className={cn('mt-4 rounded-xl border bg-surface/60 p-3.5', v.ring)} aria-live="polite">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', v.chip)}>
              <v.icon className="h-3 w-3" /> {t(v.labelKey)}
            </span>
            <span className="text-xs text-muted">
              {result.scenario.occurrences === 0
                ? t('affordabilityScenario.thatLandsBeyondThe12Week')
                : result.scenario.recurring
                  ? t('affordabilityScenario.nTimesInTheNext12Weeks', { count: result.scenario.occurrences, total: money(result.scenario.total) })
                  : t('affordabilityScenario.onceOnDate', { date: pretty(date) })}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t('affordabilityScenario.lowestBalanceAsIs')}</dt>
              <dd className="font-bold tabular-nums">{money(result.before.lowestBalance)}{result.before.lowestBalanceWeek && <span className="ml-1 text-xs font-normal text-muted">{t('affordabilityScenario.wkOf', { week: pretty(result.before.lowestBalanceWeek) })}</span>}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t('affordabilityScenario.lowestBalanceWithIt')}</dt>
              <dd className={cn('font-bold tabular-nums', result.verdict === 'breaches' ? 'text-rose-500' : result.verdict === 'tight' ? 'text-amber-500' : 'text-emerald-500')}>
                {money(result.after.lowestBalance)}{result.after.lowestBalanceWeek && <span className="ml-1 text-xs font-normal text-muted">{t('affordabilityScenario.wkOf', { week: pretty(result.after.lowestBalanceWeek) })}</span>}
              </dd>
            </div>
          </dl>

          <p className="mt-2 text-sm">
            {result.verdict === 'breaches'
              ? t('affordabilityScenario.thatWouldTakeYouUnderYour', { buffer: money(result.buffer), short: money(-result.headroom) })
              : result.verdict === 'tight'
                ? t('affordabilityScenario.itFitsButOnlyLeaves', { headroom: money(result.headroom), buffer: money(result.buffer) })
                : result.scenario.occurrences === 0
                  ? t('affordabilityScenario.nothingInTheNext12Weeks')
                  : t('affordabilityScenario.yesYouStayAboveYour', { headroom: money(result.headroom), buffer: money(result.buffer) })}
          </p>
          {result.maxAffordable !== null && result.verdict !== 'ok' && (
            <p className="mt-1 text-xs text-muted">
              {result.maxAffordable > 0
                ? t('affordabilityScenario.upToAmountKeepsYourBuffer', { amount: money(result.maxAffordable) })
                : t('affordabilityScenario.theForecastAlreadyDipsUnder')}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            <Link href="/dashboard/money-timeline" className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">
              {t('affordabilityScenario.seeTheWeekByWeekTimeline')} <ArrowRight className="h-3 w-3" />
            </Link>
            <Link href="/dashboard/family-digital-twin" className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">
              {t('affordabilityScenario.checkItAgainstABudget')} <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}
