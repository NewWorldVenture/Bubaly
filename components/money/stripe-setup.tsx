'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, ExternalLink, RefreshCw, ShieldCheck, AlertCircle, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { getConnectOnboardingUrlAction, syncConnectAccountAction } from '@/app/(app)/money/actions';

type Account = {
  account_id: string;
  status: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
};

type Props = {
  account: Account | null;
  returnedFromStripe: boolean;
  refreshRequested: boolean;
};

const STEPS = [
  { id: 'account', label: 'Create Stripe account', description: 'We create a secure payment account for your family.' },
  { id: 'verify',  label: 'Verify your identity',  description: 'Stripe requires KYC to enable real payments (5 min).' },
  { id: 'approve', label: 'Get approved',           description: 'Stripe reviews and approves your account (1-2 days).' },
  { id: 'ready',   label: 'Start using Bubaly Money', description: 'Issue cards, accept gifts, and track spending.' },
];

export function MoneySetup({ account, returnedFromStripe, refreshRequested }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(false);
  const [polling, setPolling] = useState(false);

  // Auto-sync when returning from Stripe; poll up to 6×5s for fast approval detection
  useEffect(() => {
    if ((returnedFromStripe || refreshRequested) && account?.account_id && !account.charges_enabled) {
      let attempts = 0;
      const MAX = 6;
      setPolling(true);

      async function trySync() {
        attempts++;
        const res = await syncConnectAccountAction();
        if (res.ok && res.chargesEnabled) {
          setPolling(false);
          setSynced(true);
          router.push('/money');
          return;
        }
        if (attempts < MAX) {
          setTimeout(trySync, 5000);
        } else {
          setPolling(false);
          router.refresh();
        }
      }

      trySync();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentStep = !account
    ? 0
    : !account.details_submitted
    ? 1
    : !account.charges_enabled
    ? 2
    : 3;

  async function handleOnboarding() {
    setBusy('onboard');
    setError(null);
    const res = await getConnectOnboardingUrlAction();
    setBusy(null);
    if (!res.url) { setError(res.error ?? 'Could not get onboarding link'); return; }
    window.location.href = res.url;
  }

  async function handleSync() {
    setBusy('sync');
    setError(null);
    const res = await syncConnectAccountAction();
    setBusy(null);
    if (!res.ok) { setError(res.error ?? 'Sync failed'); return; }
    setSynced(true);
    if (res.chargesEnabled) {
      router.push('/money');
    } else {
      router.refresh();
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-8 py-8">
      <div>
        <h1 className="text-2xl font-bold text-fg">Bubaly Money setup</h1>
        <p className="mt-1 text-sm text-muted">
          Connect your family to Stripe to enable real payments, debit cards, and instant transfers.
        </p>
      </div>

      {/* Progress steps */}
      <div className="space-y-3">
        {STEPS.map((step, i) => {
          const done = i < currentStep;
          const active = i === currentStep;
          return (
            <div key={step.id} className={cn(
              'flex items-start gap-4 rounded-xl border p-4 transition',
              done ? 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30'
                   : active ? 'border-brand/30 bg-brand/5'
                   : 'border-border bg-surface/50 opacity-50',
            )}>
              <div className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                done ? 'bg-green-500 text-white'
                     : active ? 'bg-brand text-white'
                     : 'bg-elevated text-muted',
              )}>
                {done ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
              </div>
              <div>
                <p className={cn('font-semibold', done ? 'text-green-800 dark:text-green-300' : 'text-fg')}>{step.label}</p>
                <p className="text-sm text-muted">{step.description}</p>
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm dark:border-red-800 dark:bg-red-950/30">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <p className="text-red-800 dark:text-red-300">{error}</p>
        </div>
      )}

      {polling && (
        <div className="flex items-center gap-3 rounded-xl border border-brand/20 bg-brand/5 p-4 text-sm">
          <RefreshCw className="h-4 w-4 animate-spin text-brand" />
          <p className="text-fg">Checking your account status with Stripe…</p>
        </div>
      )}

      {synced && (
        <div className="flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 p-4 text-sm dark:border-green-800 dark:bg-green-950/30">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
          <p className="text-green-800 dark:text-green-300">Your account is approved! Redirecting to Bubaly Money…</p>
        </div>
      )}

      {/* Action button based on step */}
      <div className="flex gap-3">
        {currentStep === 0 && (
          <p className="text-sm text-muted">Go back to <a href="/money" className="text-brand hover:underline">Money overview</a> to activate.</p>
        )}

        {currentStep === 1 && (
          <button
            onClick={handleOnboarding}
            disabled={busy === 'onboard'}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60"
          >
            <ExternalLink className="h-4 w-4" />
            {busy === 'onboard' ? 'Opening Stripe…' : 'Complete verification on Stripe'}
          </button>
        )}

        {currentStep === 2 && (
          <>
            <button
              onClick={handleOnboarding}
              disabled={busy === 'onboard'}
              className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-fg hover:bg-elevated disabled:opacity-60"
            >
              <ExternalLink className="h-4 w-4" />
              {busy === 'onboard' ? 'Opening…' : 'Return to Stripe'}
            </button>
            <button
              onClick={handleSync}
              disabled={busy === 'sync'}
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60"
            >
              <RefreshCw className={cn('h-4 w-4', busy === 'sync' && 'animate-spin')} />
              {busy === 'sync' ? 'Checking…' : 'Check approval status'}
            </button>
          </>
        )}

        {currentStep === 3 && (
          <a
            href="/money"
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-brand/90"
          >
            Go to Bubaly Money <ArrowRight className="h-4 w-4" />
          </a>
        )}
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-border bg-surface/50 p-4 text-xs text-muted">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <p>Payments are processed securely by Stripe. Bubaly never stores card numbers or bank account details.</p>
      </div>
    </div>
  );
}
