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

const FEATURES = [
  { icon: PiggyBank, title: 'Spend · Save · Give · Invest', body: 'Every child gets buckets that teach money habits for life.' },
  { icon: Gift, title: 'Grandparent gifting', body: 'Relatives can send money with a simple link — split by your rules.' },
  { icon: Sparkles, title: 'AI money coach', body: 'Goal forecasts, allowance suggestions, and gentle nudges.' },
  { icon: Users, title: 'Parent-controlled', body: 'You approve and control everything. Kids see only what you allow.' },
];

export function WalletActivation({ canActivate }: { canActivate: boolean }) {
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
      <PageHeader title="Family Wallet" description="A parent-controlled financial operating system for your family." />

      <div className="mb-6 flex flex-col items-center gap-4 rounded-3xl border border-brand/20 bg-gradient-to-br from-brand/10 to-violet-500/5 p-8 text-center">
        <div className="grid h-16 w-16 place-items-center rounded-2xl bg-brand/15">
          <Wallet className="h-8 w-8 text-brand" />
        </div>
        <div>
          <h2 className="text-xl font-bold">Activate Bubaly Family Wallet</h2>
          <p className="mt-1 text-sm text-muted">Give every child a virtual wallet with Spend, Save, Give, and Invest buckets — all controlled by you.</p>
        </div>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-2xl border border-border bg-surface/40 p-4">
            <f.icon className="mb-2 h-5 w-5 text-brand" />
            <p className="text-sm font-semibold">{f.title}</p>
            <p className="mt-0.5 text-xs text-muted">{f.body}</p>
          </div>
        ))}
      </div>

      {/* Compliance disclosures */}
      <div className="mb-5 rounded-2xl border border-border bg-surface/40 p-5">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-brand" /> Before you start
        </div>
        <ul className="space-y-2 text-xs text-muted">
          <li>• The wallet is <strong>controlled by you</strong>, the parent/guardian. Child balances are parent-managed.</li>
          <li>• In this mode, balances are <strong>tracked inside Bubaly</strong> (a virtual ledger) to teach saving and giving — they are not a bank account.</li>
          <li>• <strong>Bubaly is not a bank.</strong> When money movement and cards are enabled, funds and cards are provided through Stripe and its banking partners, with separate terms.</li>
          <li>• No claims are made about FDIC insurance, interest, or investment returns.</li>
          <li>• Any fees will be disclosed before a payment is made.</li>
        </ul>
      </div>

      {canActivate ? (
        <div className="space-y-3">
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <button type="button" onClick={() => setAgreed((v) => !v)}
              className={`mt-0.5 grid h-5 w-5 flex-shrink-0 place-items-center rounded-md border-2 transition ${agreed ? 'border-brand bg-brand text-white' : 'border-border'}`}>
              {agreed && <Check className="h-3 w-3" />}
            </button>
            <span className="text-muted">I am a parent/guardian and I accept the Family Wallet terms and disclosures above.</span>
          </label>
          <Button onClick={activate} loading={loading} disabled={!agreed} className="w-full">
            <Wallet className="h-4 w-4" /> Activate Family Wallet
          </Button>
        </div>
      ) : (
        <p className="rounded-2xl border border-border bg-surface/40 p-4 text-center text-sm text-muted">
          Only a parent or guardian can activate the Family Wallet. Ask a parent to set it up.
        </p>
      )}
    </div>
  );
}
