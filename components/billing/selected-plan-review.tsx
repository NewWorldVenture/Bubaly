'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { Button } from '@/components/ui/button';
import { PLAN_META, annualSavingsPct, slugToStripePlan, stripePlanFor } from '@/lib/billing/plans';
import type { ReviewPlan } from '@/lib/billing/review-selection';
import { cn } from '@/lib/utils/cn';

/** A URL selection is a review hint. Only the explicit confirmation can pay. */
export function SelectedPlanReview({ initialPlan, familyName, currentSlug, hasLiveSubscription, canceling, pending, syncPending, onRefresh, onConfirm }: {
  initialPlan: ReviewPlan;
  familyName: string;
  currentSlug: string | null;
  hasLiveSubscription: boolean;
  canceling: boolean;
  pending: boolean;
  syncPending: boolean;
  onRefresh: () => void;
  onConfirm: (plan: ReviewPlan) => void;
}) {
  const tr = useTranslations();
  const locale = useLocale();
  const [selected, setSelected] = useState<ReviewPlan>(initialPlan);
  const chosen = PLAN_META[selected];
  const current = hasLiveSubscription ? slugToStripePlan(currentSlug) : null;
  const currentMeta = current ? PLAN_META[current] : null;
  const isCurrent = selected === current && !canceling;
  const ref = useRef<HTMLElement>(null);
  const money = (cents: number) => new Intl.NumberFormat(locale.code, { style: 'currency', currency: 'USD' }).format(cents / 100);
  const name = (level: number) => level === 2 ? 'Family+' : 'Family Basic';
  const cadence = (annual: boolean) => tr(annual ? 'billing.yearly' : 'billing.monthly');

  useEffect(() => { ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, []);

  return (
    <section ref={ref} aria-labelledby="selected-plan-review-heading" data-review-plan={selected} className="scroll-mt-20 space-y-4 rounded-xl border-2 border-brand/50 bg-brand/5 p-4">
      <h3 id="selected-plan-review-heading" className="font-bold">{tr('billingReview.title')}</h3>
      <p className="break-words text-sm">{tr('billingReview.family', { family: familyName })}</p>
      <p className="text-sm text-muted">{tr('billingReview.current', {
        plan: currentMeta ? `${name(currentMeta.level)} · ${cadence(currentMeta.interval === 'annual')}` : 'Bubaly Free',
      })}</p>
      <fieldset disabled={pending || syncPending} className="space-y-2">
        <legend className="mb-2 text-sm font-semibold">{tr('billingReview.plan')}</legend>
        <div className="grid grid-cols-2 gap-2">
          {([1, 2] as const).map(level => (
            <button key={level} type="button" aria-pressed={chosen.level === level}
              onClick={() => setSelected(stripePlanFor(level, chosen.interval))}
              className={cn('rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50', chosen.level === level ? 'border-brand bg-brand text-white' : 'border-border bg-surface')}>
              {name(level)}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={pending || syncPending} className="space-y-2">
        <legend className="mb-2 text-sm font-semibold">{tr('billingReview.interval')}</legend>
        <div className="grid grid-cols-2 gap-2">
          {(['monthly', 'annual'] as const).map(interval => (
            <button key={interval} type="button" aria-pressed={chosen.interval === interval}
              onClick={() => setSelected(stripePlanFor(chosen.level, interval))}
              className={cn('rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50', chosen.interval === interval ? 'border-brand bg-brand text-white' : 'border-border bg-surface')}>
              {cadence(interval === 'annual')}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1" aria-live="polite">
        <p className="text-xl font-bold">{name(chosen.level)} · {cadence(chosen.interval === 'annual')}</p>
        <p className="text-base font-semibold">{tr(chosen.interval === 'annual' ? 'billingReview.annualTotal' : 'billingReview.monthlyTotal', { amount: money(chosen.totalCents) })}</p>
        {chosen.interval === 'annual' && <p className="text-sm">{tr('billingReview.equivalent', { amount: money(chosen.monthlyCents), percent: annualSavingsPct(chosen.level) })}</p>}
        <p className="text-sm text-muted">{tr('billingReview.noServiceFee')}</p>
        {current && selected !== current && <p className="text-sm text-muted">{tr(currentMeta?.interval !== chosen.interval ? 'billingReview.prorationImmediate' : 'billingReview.proration')}</p>}
        {current && selected === current && canceling && <p className="text-sm text-muted">{tr('billingReview.resume')}</p>}
      </div>
      <p className="text-sm text-muted" role={syncPending ? 'status' : undefined}>{tr(syncPending ? 'changePlan.stripeChangedThePlanBut' : isCurrent ? 'billingReview.alreadyCurrent' : 'billingReview.confirmationRequired')}</p>
      <Button className="w-full whitespace-normal" loading={pending} disabled={pending || syncPending || isCurrent} onClick={() => { if (!pending && !syncPending && !isCurrent) onConfirm(selected); }}>
        {tr(isCurrent ? 'billingReview.currentPlan' : 'billingReview.confirm')}
      </Button>
      {syncPending && <Button className="w-full whitespace-normal" variant="secondary" loading={pending} onClick={onRefresh}>{tr('billingReview.refreshStatus')}</Button>}
      <Link href="/dashboard/billing?view=manage" className="block text-center text-sm underline underline-offset-2">{tr('billingReview.dismiss')}</Link>
    </section>
  );
}
