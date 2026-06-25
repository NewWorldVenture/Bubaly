import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { formatCents } from '@/lib/wallet/ledger';
import { CheckCircle2 } from 'lucide-react';

export const metadata: Metadata = { title: 'Gift sent! · Bubaly', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function GiftSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const { session: sessionId } = await searchParams;

  let childName = 'your child';
  let amountCents: number | null = null;

  if (sessionId) {
    const supabase = createServiceClient();
    const { data: gift } = await supabase
      .from('gift_payments')
      .select('amount_cents, child_wallet_id')
      .eq('stripe_ref', sessionId)
      .maybeSingle();

    if (gift) {
      amountCents = gift.amount_cents;
      if (gift.child_wallet_id) {
        const { data: cw } = await supabase
          .from('child_wallets')
          .select('member_id')
          .eq('id', gift.child_wallet_id)
          .maybeSingle();
        if (cw?.member_id) {
          const { data: m } = await supabase
            .from('family_members')
            .select('display_name')
            .eq('id', cw.member_id)
            .maybeSingle();
          if (m?.display_name) childName = m.display_name;
        }
      }
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100">
        <CheckCircle2 className="h-10 w-10 text-emerald-600" />
      </div>
      <div>
        <h1 className="text-3xl font-bold">Gift sent! 🎉</h1>
        {amountCents && (
          <p className="mt-2 text-lg font-semibold text-emerald-600">{formatCents(amountCents)}</p>
        )}
        <p className="mt-2 text-muted">
          Your gift to {childName} is on its way. It will appear in their Bubaly Wallet shortly.
        </p>
      </div>
      <p className="max-w-xs text-xs text-muted">
        You&apos;ll receive a payment confirmation from Stripe. The child&apos;s wallet is updated automatically once payment clears.
      </p>
    </div>
  );
}
