import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { getMoneyCapabilities } from '@/lib/stripe/capabilities';
import { syncConnectedAccount } from '@/lib/stripe/connect';
import { WalletActivation } from '@/components/wallet/wallet-activation';
import { MoneyCardsView, type CardChild, type IssuedCard } from '@/components/wallet/money-cards-view';

export const metadata: Metadata = { title: 'Wallet Cards' };
export const dynamic = 'force-dynamic';

export default async function WalletCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string }>;
}) {
  const { setup } = await searchParams;
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const svc = createServiceClient();

  const { data: wallet } = await supabase
    .from('family_wallets').select('id, is_active').eq('family_id', familyId).maybeSingle();
  if (!wallet || !wallet.is_active) return <WalletActivation canActivate={isManager(ctx.active.role)} />;

  const caps = await getMoneyCapabilities(svc);

  // If returning from Stripe onboarding, pull the latest status before rendering.
  if (setup === 'complete' || setup === 'refresh') {
    const { data: existingAcct } = await svc.from('stripe_connected_accounts')
      .select('stripe_account_id').eq('family_id', familyId).maybeSingle();
    if (existingAcct?.stripe_account_id) {
      await syncConnectedAccount(svc, familyId, existingAcct.stripe_account_id).catch(() => {});
    }
  }

  const [{ data: account }, { data: childWallets }, { data: members }, { data: cards }] = await Promise.all([
    supabase.from('stripe_connected_accounts')
      .select('status, charges_enabled, details_submitted, card_issuing_enabled').eq('family_id', familyId).maybeSingle(),
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
    supabase.from('stripe_issuing_cards')
      .select('id, child_wallet_id, type, status, last4, brand, is_frozen, spend_limit_cents, spend_window, blocked_categories')
      .eq('family_id', familyId),
  ]);

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));
  const childList: CardChild[] = (childWallets ?? []).map((cw) => {
    const m = memberById.get(cw.member_id);
    return { id: cw.id, name: m?.display_name ?? 'Child', color: m?.color ?? null };
  });
  const issued: IssuedCard[] = (cards ?? []).map((c) => ({
    id: c.id, childWalletId: c.child_wallet_id, type: c.type, status: c.status,
    last4: c.last4, brand: c.brand, isFrozen: c.is_frozen,
    spendLimitCents: c.spend_limit_cents, spendWindow: c.spend_window, blockedCategories: c.blocked_categories ?? [],
  }));

  return (
    <MoneyCardsView
      capabilities={{
        connectOnboarding: caps.connectOnboarding, issuing: caps.issuing, physicalCards: caps.physicalCards,
      }}
      accountReady={!!account?.card_issuing_enabled}
      onboardingStarted={!!account}
      justCompletedSetup={setup === 'complete'}
      childWallets={childList}
      cards={issued}
      canManage={isManager(ctx.active.role)}
    />
  );
}
