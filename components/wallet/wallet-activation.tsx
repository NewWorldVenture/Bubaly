'use client';

// Family Wallet activation — explains the product, surfaces the compliance
// disclosures, and (for a parent/guardian) provisions the virtual-ledger wallet.
import { useState } from 'react';
import { Wallet, ShieldCheck, Users, PiggyBank, Gift, Sparkles, Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { activateFamilyWalletAction } from '@/app/(app)/wallet/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

const FEATURES = [
  { icon: PiggyBank, title: 'Spend · Save · Give · Invest', body: 'Every child gets buckets that teach money habits for life.' },
  { icon: Gift, title: 'Grandparent gifting', body: 'Relatives can send money with a simple link — split by your rules.' },
  { icon: Sparkles, title: 'AI money coach', body: 'Goal forecasts, allowance suggestions, and gentle nudges.' },
  { icon: Users, title: 'Parent-controlled', body: 'You approve and control everything. Kids see only what you allow.' },
];

export function WalletActivation({ canActivate }: { canActivate: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);

  async function activate() {
    setLoading(true);
    const res = await activateFamilyWalletAction();
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not activate the wallet');
    success('Family Wallet activated 🎉');
    router.refresh();
  }

  return (
    <div className="module-page mx-auto max-w-2xl">
      <PageHeader title={t('walletActivation.familyWallet')} description={t('walletActivation.aParentControlledFinancialOperating')} />

      <div className="mb-6 flex flex-col items-center gap-4 rounded-3xl border border-brand/20 bg-gradient-to-br from-brand/10 to-violet-500/5 p-8 text-center">
        <div className="grid h-16 w-16 place-items-center rounded-2xl bg-brand/15">
          <Wallet className="h-8 w-8 text-brand-text" />
        </div>
        <div>
          <h2 className="text-xl font-bold">{t('walletActivation.activateBubalyFamilyWallet')}</h2>
          <p className="mt-1 text-sm text-muted">{t('walletActivation.giveEveryChildAVirtualWallet')}</p>
        </div>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-2xl border border-border bg-surface/40 p-4">
            <f.icon className="mb-2 h-5 w-5 text-brand-text" />
            <p className="text-sm font-semibold">{f.title}</p>
            <p className="mt-0.5 text-xs text-muted">{f.body}</p>
          </div>
        ))}
      </div>

      {/* Compliance disclosures */}
      <div className="mb-5 rounded-2xl border border-border bg-surface/40 p-5">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-brand-text" /> {t('walletActivation.beforeYouStart')}
        </div>
        <ul className="space-y-2 text-xs text-muted">
          <li>{t('walletActivation.theWalletIs')} <strong>{t('walletActivation.controlledByYou')}</strong>{t('walletActivation.theParentGuardianChildBalancesAre')}</li>
          <li>{t('walletActivation.inThisModeBalancesAre')} <strong>{t('walletActivation.trackedInsideBubaly')}</strong> {t('walletActivation.aVirtualLedgerToTeachSaving')}</li>
          <li>• <strong>{t('walletActivation.bubalyIsNotABank')}</strong>{' '}{t('walletActivation.whenMoneyMovementAndCards')}</li>
          <li>{t('walletActivation.noClaimsAreMadeAboutFdic')}</li>
          <li>{t('walletActivation.anyFeesWillBeDisclosedBefore')}</li>
        </ul>
      </div>

      {canActivate ? (
        <div className="space-y-3">
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <button type="button" onClick={() => setAgreed((v) => !v)}
              className={`mt-0.5 grid h-5 w-5 flex-shrink-0 place-items-center rounded-md border-2 transition ${agreed ? 'border-brand bg-brand text-white' : 'border-border'}`}>
              {agreed && <Check className="h-3 w-3" />}
            </button>
            <span className="text-muted">{t('walletActivation.iAmAParentGuardianAnd')}</span>
          </label>
          <Button onClick={activate} loading={loading} disabled={!agreed} className="w-full">
            <Wallet className="h-4 w-4" /> {t('walletActivation.activateFamilyWallet')}
          </Button>
        </div>
      ) : (
        <p className="rounded-2xl border border-border bg-surface/40 p-4 text-center text-sm text-muted">
          {t('walletActivation.onlyAParentOrGuardianCan')}
        </p>
      )}
    </div>
  );
}
