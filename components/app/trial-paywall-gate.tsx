'use client';

// Shown over the whole app when a family's 5-day free trial has ended and they
// haven't subscribed. Offers Family Basic or Family+ (no downgrade to free), a
// link to full pricing, log out, and soft account closure. Nothing is deleted.
import { useState } from 'react';
import Link from 'next/link';
import { Crown, Sparkles, Check, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { closeAccountAction } from '@/app/(app)/account/actions';
import { BASIC_ANNUAL_CENTS, PLUS_ANNUAL_CENTS } from '@/lib/constants/plans';
import { cn } from '@/lib/utils/cn';
import { useLockBodyScroll } from '@/lib/hooks/use-lock-body-scroll';

const fmt = (cents: number) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

export function TrialPaywallGate({ trialEndsAt }: { trialEndsAt?: string | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const { error: toastError, success } = useToast();

  // Blocking full-screen paywall: lock the page behind it so it can't be
  // scrolled out from under on mobile.
  useLockBodyScroll(true);

  async function checkout(plan: 'basic_annual' | 'plus_annual') {
    if (busy) return;
    setBusy(plan);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.url) { window.location.href = json.url as string; return; }
      toastError(json.error || 'Could not start checkout. Please try again.');
    } catch {
      toastError('Could not start checkout. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function close() {
    if (!window.confirm('Close your account? Nothing is deleted — you can reopen anytime and everything will be here.')) return;
    setBusy('close');
    const res = await closeAccountAction();
    setBusy(null);
    if (res.ok) { success('Your account is closed. Your data is safe.'); window.location.reload(); }
    else toastError(res.error);
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="paywall-title"
      className="fixed inset-0 z-[200] grid place-items-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-3xl border border-white/10 bg-surface p-6 shadow-2xl sm:p-8">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-violet-500/15 text-violet-400 ring-1 ring-violet-400/30">
          <Lock className="h-6 w-6" />
        </div>
        <h1 id="paywall-title" className="mt-4 text-center text-2xl font-black text-fg">Your free trial has ended</h1>
        <p className="mx-auto mt-2 max-w-sm text-center text-sm text-muted">
          Choose a plan to unlock Bubaly again. Everything you created is safe and waiting — nothing was deleted.
        </p>

        <div className="mt-6 space-y-3">
          <PlanRow
            icon={<Crown className="h-5 w-5 text-yellow-400" />}
            name="Family Basic" price={`${fmt(BASIC_ANNUAL_CENTS)}/yr`} tagline="The best family organizer on earth."
            busy={busy === 'basic_annual'} onClick={() => checkout('basic_annual')} featured
          />
          <PlanRow
            icon={<Sparkles className="h-5 w-5 text-violet-400" />}
            name="Family+" price={`${fmt(PLUS_ANNUAL_CENTS)}/yr`} tagline="Your family’s AI Chief of Staff."
            busy={busy === 'plus_annual'} onClick={() => checkout('plus_annual')}
          />
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm">
          <Link href="/pricing" className="text-brand-text hover:underline">See all plans & monthly pricing</Link>
          <span className="text-muted/40">·</span>
          <a href="/auth/signout" className="text-muted hover:text-fg">Log out</a>
          <span className="text-muted/40">·</span>
          <button type="button" onClick={close} disabled={!!busy} className="text-muted hover:text-fg disabled:opacity-50">
            Close account
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanRow({ icon, name, price, tagline, onClick, busy, featured }: {
  icon: React.ReactNode; name: string; price: string; tagline: string;
  onClick: () => void; busy: boolean; featured?: boolean;
}) {
  return (
    <div className={cn(
      'flex items-center gap-3 rounded-2xl border p-3.5',
      featured ? 'border-violet-400/50 bg-violet-500/[0.06]' : 'border-border bg-elevated/40',
    )}>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-bold text-fg">{name} <span className="text-xs font-semibold text-muted">{price}</span></p>
        <p className="truncate text-xs text-muted">{tagline}</p>
      </div>
      <Button size="sm" onClick={onClick} disabled={busy} aria-busy={busy} className="shrink-0 gap-1">
        <Check className="h-3.5 w-3.5" /> {busy ? 'Starting…' : 'Choose'}
      </Button>
    </div>
  );
}
