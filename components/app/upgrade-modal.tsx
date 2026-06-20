'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Lock, Sparkles } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { PLANS } from '@/lib/constants/plans';
import { useApp } from './app-context';

/** Stripe checkout — same endpoint the billing module uses. */
async function startCheckout(plan: 'family_monthly' | 'family_annual'): Promise<string | null> {
  const res = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan }),
  });
  const json = (await res.json()) as { url?: string; error?: string };
  if (json.url) return json.url;
  throw new Error(json.error ?? 'Could not start checkout');
}

const BASIC = PLANS.find((p) => p.id === 'basic')!;

/**
 * Shown when a member taps a locked (paid) feature. Promotes Family Basic —
 * the tier that unlocks every locked sidebar item — with one-tap Stripe
 * checkout. Only family admins can purchase; others see a gentle nudge.
 */
export function UpgradeModal({
  open,
  onClose,
  featureLabel,
}: {
  open: boolean;
  onClose: () => void;
  featureLabel?: string | null;
}) {
  const { role } = useApp();
  const { error: toastError } = useToast();
  const [pending, setPending] = useState<null | 'family_monthly' | 'family_annual'>(null);
  const isAdmin = role === 'parent';

  async function checkout(plan: 'family_monthly' | 'family_annual') {
    setPending(plan);
    try {
      const url = await startCheckout(plan);
      if (url) window.location.href = url;
    } catch (err) {
      setPending(null);
      toastError(err instanceof Error ? err.message : 'Could not start checkout');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={featureLabel ? `Unlock ${featureLabel}` : 'Upgrade to Family Basic'}
      description="Available on Family Basic and above."
    >
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-2xl border border-brand/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-4">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/15">
            <Sparkles className="h-5 w-5 text-brand" />
          </div>
          <div>
            <p className="font-semibold">{BASIC.name}</p>
            <p className="text-sm text-muted">{BASIC.tagline}</p>
          </div>
        </div>

        <ul className="grid gap-2 sm:grid-cols-2">
          {BASIC.features.map((f) => (
            <li key={f} className="flex items-center gap-2 text-sm">
              <Check className="h-4 w-4 shrink-0 text-emerald-400" />
              <span className="text-fg/90">{f}</span>
            </li>
          ))}
        </ul>

        {isAdmin ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              onClick={() => checkout('family_monthly')}
              disabled={pending !== null}
              className="rounded-2xl border border-border bg-surface/40 p-4 text-left transition hover:bg-elevated disabled:opacity-60"
            >
              <p className="text-sm font-semibold">Monthly</p>
              <p className="mt-1 text-2xl font-bold">$9.99<span className="text-sm font-normal text-muted">/mo</span></p>
              <span className="mt-2 inline-block text-xs font-semibold text-brand">
                {pending === 'family_monthly' ? 'Redirecting…' : 'Choose monthly →'}
              </span>
            </button>
            <button
              onClick={() => checkout('family_annual')}
              disabled={pending !== null}
              className="rounded-2xl border border-brand/30 bg-brand/5 p-4 text-left transition hover:bg-brand/10 disabled:opacity-60"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Annual</p>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400">Save ~17%</span>
              </div>
              <p className="mt-1 text-2xl font-bold">$8.33<span className="text-sm font-normal text-muted">/mo</span></p>
              <span className="mt-2 inline-block text-xs font-semibold text-brand">
                {pending === 'family_annual' ? 'Redirecting…' : 'Choose annual →'}
              </span>
            </button>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-2xl border border-border bg-surface/40 p-4">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
            <p className="text-sm text-muted">
              Ask a family admin to upgrade your plan to unlock this feature.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between">
          <Link href="/pricing" onClick={onClose} className="text-xs font-semibold text-muted hover:text-fg">
            Compare all plans →
          </Link>
          <Button variant="ghost" size="sm" onClick={onClose}>Maybe later</Button>
        </div>
      </div>
    </Modal>
  );
}
