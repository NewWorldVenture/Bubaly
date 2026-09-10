'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Lock, Sparkles } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import {
  PLANS, BASIC_MONTHLY_CENTS, BASIC_ANNUAL_CENTS, PLUS_MONTHLY_CENTS, PLUS_ANNUAL_CENTS,
} from '@/lib/constants/plans';
import { formatPerDay, perDayCents, valueTierForLevel } from '@/lib/marketing/value';
import type { StripePlan } from '@/lib/stripe';
import { useApp } from './app-context';
import { describeDbError } from '@/lib/supabase/errors';
import { useTranslations } from '@/components/i18n/locale-provider';

/**
 * Stripe checkout — same endpoint the billing module uses.
 *
 * Takes the translator as an ARGUMENT rather than calling `useTranslations()`.
 * This is module scope, not a component, so a hook here is a rules-of-hooks
 * violation — and it is one that only lint and `next build` report, never tsc.
 */
async function startCheckout(plan: StripePlan, t: (key: string) => string): Promise<string | null> {
  const res = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan }),
  });
  const json = (await res.json()) as { url?: string; error?: string };
  if (json.url) return json.url;
  throw new Error(json.error ?? t('upgradeModal.couldNotStartCheckout'));
}

const dollars = (cents: number) =>
  (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// Tier presentation, keyed by the plan level a locked feature requires.
const TIERS = {
  1: {
    plan: PLANS.find((p) => p.id === 'basic')!,
    monthlyPlan: 'basic_monthly' as StripePlan,
    annualPlan: 'basic_annual' as StripePlan,
    monthlyCents: BASIC_MONTHLY_CENTS,
    annualCents: BASIC_ANNUAL_CENTS,
    annualPerMoCents: Math.round(BASIC_ANNUAL_CENTS / 12),
  },
  2: {
    plan: PLANS.find((p) => p.id === 'plus')!,
    monthlyPlan: 'plus_monthly' as StripePlan,
    annualPlan: 'plus_annual' as StripePlan,
    monthlyCents: PLUS_MONTHLY_CENTS,
    annualCents: PLUS_ANNUAL_CENTS,
    annualPerMoCents: Math.round(PLUS_ANNUAL_CENTS / 12),
  },
} as const;

/**
 * Shown when a member taps a locked feature. Promotes the *correct* tier for
 * that feature — Family Basic for level-1 features, Family+ for level-2 — with
 * one-tap Stripe checkout. Only family admins can purchase; others see a nudge.
 *
 * The pitch is outcome-first: what stops landing on the family leads, and the
 * feature checklist follows as "also included". Both the outcomes and the
 * per-day figures come from lib/marketing/value.ts — the same registry and the
 * same ceil-rounded arithmetic /pricing renders — so the two surfaces cannot
 * drift and neither can understate the price.
 */
export function UpgradeModal({
  open,
  onClose,
  featureLabel,
  requiredLevel = 1,
}: {
  open: boolean;
  onClose: () => void;
  featureLabel?: string | null;
  requiredLevel?: number;
}) {
  const t = useTranslations();
  const { role } = useApp();
  const { error: toastError } = useToast();
  const [pending, setPending] = useState<StripePlan | null>(null);
  const isAdmin = role === 'parent';

  const tier = TIERS[requiredLevel === 2 ? 2 : 1];
  const { plan } = tier;
  const copy = valueTierForLevel(requiredLevel === 2 ? 2 : 1);
  const monthlyPerDay = t('pricingValue.perDay', { amount: formatPerDay(perDayCents(tier.monthlyCents, 'monthly')) });
  const annualPerDay = t('pricingValue.perDay', { amount: formatPerDay(perDayCents(tier.annualCents, 'yearly')) });

  async function checkout(stripePlan: StripePlan) {
    setPending(stripePlan);
    try {
      const url = await startCheckout(stripePlan, t);
      if (url) window.location.href = url;
    } catch (err) {
      setPending(null);
      toastError(describeDbError(err, t('upgradeModal.couldNotStartCheckout')));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={featureLabel ? t('upgradeModal.unlockFeature', { feature: featureLabel }) : t('upgradeModal.upgradeToPlan', { plan: plan.name })}
      description={t('upgradeModal.availableOnPlan', { plan: plan.name })}
    >
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-2xl border border-brand/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-4">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/15">
            <Sparkles className="h-5 w-5 text-brand-text" />
          </div>
          <div>
            <p className="font-semibold">{plan.name}</p>
            <p className="text-sm text-muted">{t(copy.goalKey)}</p>
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">{t('planOutcomes.heading')}</p>
          <ul className="mt-2 space-y-2">
            {copy.outcomes.map((outcome) => (
              <li key={outcome.labelKey} className="flex items-start gap-2 text-sm font-medium">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-text" aria-hidden />
                <span className="text-fg/90">{t(outcome.labelKey)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">{t('upgradeModal.alsoIncluded')}</p>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {plan.features.map((f) => (
              <li key={f} className="flex items-center gap-2 text-xs text-muted">
                <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>

        {isAdmin ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              onClick={() => checkout(tier.monthlyPlan)}
              disabled={pending !== null}
              className="rounded-2xl border border-border bg-surface/40 p-4 text-left transition hover:bg-elevated disabled:opacity-60"
            >
              <p className="text-sm font-semibold">{t('upgradeModal.monthly')}</p>
              <p className="mt-1 text-2xl font-bold">{dollars(tier.monthlyCents)}<span className="text-sm font-normal text-muted">/mo</span></p>
              <p className="mt-0.5 text-xs text-muted">{monthlyPerDay}</p>
              <span className="mt-2 inline-block text-xs font-semibold text-brand-text">
                {pending === tier.monthlyPlan ? t('upgradeModal.redirecting') : t('upgradeModal.chooseMonthly')}
              </span>
            </button>
            <button
              onClick={() => checkout(tier.annualPlan)}
              disabled={pending !== null}
              className="rounded-2xl border border-brand/30 bg-brand/5 p-4 text-left transition hover:bg-brand/10 disabled:opacity-60"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">{t('upgradeModal.annual')}</p>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400">{t('upgradeModal.save17')}</span>
              </div>
              <p className="mt-1 text-2xl font-bold">{dollars(tier.annualPerMoCents)}<span className="text-sm font-normal text-muted">/mo</span></p>
              <p className="mt-0.5 text-xs font-medium text-fg/80">{t('upgradeModal.billedAnnually', { amount: dollars(tier.annualCents) })}</p>
              <p className="mt-0.5 text-xs text-muted">{annualPerDay}</p>
              <span className="mt-2 inline-block text-xs font-semibold text-brand-text">
                {pending === tier.annualPlan ? t('upgradeModal.redirecting') : t('upgradeModal.chooseAnnual')}
              </span>
            </button>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-2xl border border-border bg-surface/40 p-4">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
            <p className="text-sm text-muted">
              {t('upgradeModal.askAFamilyAdminToUpgrade')}
            </p>
          </div>
        )}

        <div className="flex items-center justify-between">
          <Link href="/pricing" onClick={onClose} className="text-xs font-semibold text-muted hover:text-fg">
            {t('upgradeModal.compareAllPlans')}
          </Link>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('upgradeModal.maybeLater')}</Button>
        </div>
      </div>
    </Modal>
  );
}
