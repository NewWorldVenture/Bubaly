'use client';

// components/referrals/referral-home-card.tsx — the Home prompt into /referrals.
//
// Rendered by the Home page only when the server has read that the family has
// invited at least one member (the household is set up, so "know another
// family?" is the natural next ask) and this user has not dismissed it. The
// dismissal is persisted on the user's own preferences row, so it stays
// dismissed across devices.
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Gift, X, ArrowRight } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { useTranslations } from '@/components/i18n/locale-provider';
import { dismissReferralHomeCardAction } from '@/app/(app)/referrals/actions';

export function ReferralHomeCard({ give, get }: { give: string; get: string }) {
  const t = useTranslations();
  const { error: toastError } = useToast();
  const [hidden, setHidden] = useState(false);
  const [pending, startTransition] = useTransition();

  if (hidden) return null;

  function dismiss() {
    startTransition(async () => {
      const res = await dismissReferralHomeCardAction();
      if (res.ok) setHidden(true);
      else toastError(res.reason);
    });
  }

  return (
    <section
      className="flex items-center gap-3 rounded-2xl border border-brand/30 bg-brand/5 px-4 py-3"
      data-testid="referral-home-card"
      aria-label={t('referralHomeCard.title')}
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text">
        <Gift className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{t('referralHomeCard.title')}</p>
        <p className="text-xs text-muted">{t('referralHomeCard.body', { give, get })}</p>
      </div>
      <Link
        href="/referrals"
        className="hidden shrink-0 items-center gap-1 rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand/90 sm:inline-flex"
      >
        {t('referralHomeCard.cta')} <ArrowRight className="h-3.5 w-3.5" />
      </Link>
      <Link href="/referrals" className="shrink-0 text-xs font-semibold text-brand-text sm:hidden">
        {t('referralHomeCard.cta')}
      </Link>
      <button
        type="button"
        onClick={dismiss}
        disabled={pending}
        className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg disabled:opacity-60"
        aria-label={t('referralHomeCard.dismiss')}
      >
        <X className="h-4 w-4" />
      </button>
    </section>
  );
}
