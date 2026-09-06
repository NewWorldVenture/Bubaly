'use client';

import { useState, useTransition } from 'react';
import {
  FlaskConical, CalendarPlus, Wallet, Loader2, CheckCircle2, AlertTriangle, XCircle, ArrowRight,
} from 'lucide-react';
import { simulateDecisionAction, type SimFormInput } from '@/app/(app)/dashboard/family-digital-twin/actions';
import type { SimResult, Verdict } from '@/lib/twin/simulate';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

type Member = { id: string; display_name: string };

const VERDICT: Record<Verdict, { label: string; icon: typeof CheckCircle2; chip: string; ring: string }> = {
  clear: { label: 'Clear', icon: CheckCircle2, chip: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400', ring: 'border-emerald-500/30' },
  tight: { label: 'Tight', icon: AlertTriangle, chip: 'bg-amber-500/12 text-amber-600 dark:text-amber-400', ring: 'border-amber-500/30' },
  conflict: { label: 'Conflict', icon: XCircle, chip: 'bg-rose-500/12 text-rose-600 dark:text-rose-400', ring: 'border-rose-500/30' },
};

const SEV_ICON = {
  ok: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />,
  caution: <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />,
  blocker: <XCircle className="h-3.5 w-3.5 text-rose-500" />,
};

// The Household Digital Twin's decision simulator — "if we do X, what moves?"
// Safe what-if: runs against real family data, writes nothing.
export function DecisionSimulator({ members, budgetCategories }: { members: Member[]; budgetCategories: string[] }) {
  const t = useTranslations();
  const [tab, setTab] = useState<'commitment' | 'spend'>('commitment');
  const [result, setResult] = useState<SimResult | null>(null);
  const [pending, start] = useTransition();

  // commitment fields
  const [memberId, setMemberId] = useState(members[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('16:00');
  const [durationMin, setDurationMin] = useState(60);
  const [weeks, setWeeks] = useState(1);

  // spend fields
  const [category, setCategory] = useState(budgetCategories[0] ?? '');
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');

  const run = () => {
    let input: SimFormInput;
    if (tab === 'commitment') {
      const member = members.find((m) => m.id === memberId);
      const startsAt = day ? new Date(`${day}T${time}:00`).toISOString() : '';
      input = { kind: 'commitment', memberId, memberName: member?.display_name ?? 'They', title, startsAt, durationMin, weeks };
    } else {
      input = { kind: 'spend', category, amountDollars: parseFloat(amount) || 0, label };
    }
    start(async () => {
      try {
        setResult(await simulateDecisionAction(input));
      } catch {
        setResult({ verdict: 'conflict', headline: 'Could not run the simulation. Try again.', impacts: [] });
      }
    });
  };

  const v = result ? VERDICT[result.verdict] : null;

  return (
    <div className="rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/[0.06] to-surface/40 p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand/15 text-brand-text"><FlaskConical className="h-4 w-4" /></span>
        <div>
          <h2 className="text-sm font-semibold">{t('decisionSimulator.decisionSimulator')}</h2>
          <p className="text-xs text-muted">{t('decisionSimulator.tryADecisionBeforeYouMake')}</p>
        </div>
      </div>

      <div className="mb-3 inline-flex rounded-lg border border-border bg-surface/60 p-0.5 text-sm">
        <button
          onClick={() => { setTab('commitment'); setResult(null); }}
          className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition', tab === 'commitment' ? 'bg-brand text-white' : 'text-muted hover:text-fg')}
        >
          <CalendarPlus className="h-3.5 w-3.5" /> {t('decisionSimulator.addACommitment')}
        </button>
        <button
          onClick={() => { setTab('spend'); setResult(null); }}
          className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition', tab === 'spend' ? 'bg-brand text-white' : 'text-muted hover:text-fg')}
        >
          <Wallet className="h-3.5 w-3.5" /> {t('decisionSimulator.aBigSpend')}
        </button>
      </div>

      {tab === 'commitment' ? (
        <div className="grid gap-2.5 sm:grid-cols-2">
          <label className="text-xs font-medium text-muted">Who
            <select value={memberId} onChange={(e) => setMemberId(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-fg">
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-muted">{t('decisionSimulator.what')}
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('decisionSimulator.soccerTournament')} className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-fg" />
          </label>
          <label className="text-xs font-medium text-muted">Day
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-fg" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-medium text-muted">{t('decisionSimulator.start')}
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-fg" />
            </label>
            <label className="text-xs font-medium text-muted">{t('decisionSimulator.minutes')}
              <input type="number" min={15} step={15} value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-fg" />
            </label>
          </div>
          <label className="text-xs font-medium text-muted">{t('decisionSimulator.repeatForWeeks')}
            <input type="number" min={1} max={52} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-fg" />
          </label>
        </div>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          <label className="text-xs font-medium text-muted">{t('decisionSimulator.budget')}
            {budgetCategories.length > 0 ? (
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-fg">
                {budgetCategories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : (
              <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t('decisionSimulator.vacation')} className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-fg" />
            )}
          </label>
          <label className="text-xs font-medium text-muted">{t('decisionSimulator.amount')}
            <input type="number" min={0} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="400" className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-fg" />
          </label>
          <label className="text-xs font-medium text-muted sm:col-span-2">{t('decisionSimulator.whatForOptional')}
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('decisionSimulator.twoExtraNights')} className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-fg" />
          </label>
        </div>
      )}

      <button
        onClick={run}
        disabled={pending}
        className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/90 disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
        {t('decisionSimulator.simulate')}
      </button>

      {result && v && (
        <div className={cn('mt-4 rounded-xl border bg-surface/60 p-3.5', v.ring)}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', v.chip)}>
              <v.icon className="h-3 w-3" /> {v.label}
            </span>
          </div>
          <p className="text-sm font-medium">{result.headline}</p>
          {result.impacts.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {result.impacts.map((im, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className="mt-0.5">{SEV_ICON[im.severity]}</span>
                  <span><span className="font-medium text-fg">{im.title}</span>{im.detail && <span className="text-muted"> — {im.detail}</span>}</span>
                </li>
              ))}
            </ul>
          )}
          {result.verdict === 'conflict' && (
            <a href="/dashboard/calendar" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">
              {t('decisionSimulator.openTheCalendarToRearrange')} <ArrowRight className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
