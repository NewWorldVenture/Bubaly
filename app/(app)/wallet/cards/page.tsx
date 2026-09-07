import type { Metadata } from 'next';
import { AlertTriangle } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { getMoneyCapabilities } from '@/lib/stripe/capabilities';
import { syncConnectedAccount } from '@/lib/stripe/connect';
import { WalletActivation } from '@/components/wallet/wallet-activation';
import { MoneyCardsView, type CardChild, type IssuedCard } from '@/components/wallet/money-cards-view';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Wallet Cards' };
export const dynamic = 'force-dynamic';

export default async function WalletCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string }>;
}) {
  const t = await getTranslations();
  const { setup } = await searchParams;
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const svc = createServiceClient();
  const dataWarnings: string[] = [];

  const { data: wallet, error: walletError } = await supabase
    .from('family_wallets').select('id, is_active').eq('family_id', familyId).maybeSingle();
  if (walletError) {
    console.error('[wallet-cards] Wallet read failed', walletError);
    return <ErrorState message="Could not load the family wallet. Refresh and try again." />;
  }
  if (!wallet || !wallet.is_active) return <WalletActivation canActivate={isManager(ctx.active.role)} />;

  const caps = await getMoneyCapabilities(svc);

  // If returning from Stripe onboarding, pull the latest status before rendering.
  if (setup === 'complete' || setup === 'refresh') {
    const { data: existingAcct, error: existingAcctError } = await svc.from('stripe_connected_accounts')
      .select('stripe_account_id').eq('family_id', familyId).maybeSingle();
    if (existingAcctError) {
      console.error('[wallet-cards] Connected account read failed', existingAcctError);
      dataWarnings.push('Connected account');
    } else if (existingAcct?.stripe_account_id) {
      await syncConnectedAccount(svc, familyId, existingAcct.stripe_account_id).catch((error) => {
        console.error('[wallet-cards] Connected account sync failed', error);
        dataWarnings.push('Connected account sync');
      });
    }
  }

  const [{ data: account, error: accountError }, { data: childWallets, error: childWalletsError }, { data: members, error: membersError }, { data: cards, error: cardsError }] = await Promise.all([
    supabase.from('stripe_connected_accounts')
      .select('status, charges_enabled, details_submitted, card_issuing_enabled').eq('family_id', familyId).maybeSingle(),
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
    supabase.from('stripe_issuing_cards')
      .select('id, child_wallet_id, type, status, last4, brand, is_frozen, spend_limit_cents, spend_window, blocked_categories')
      .eq('family_id', familyId),
  ]);
  if (accountError) { console.error('[wallet-cards] Connected account status read failed', accountError); dataWarnings.push('Connected account status'); }
  if (childWalletsError) { console.error('[wallet-cards] Child wallets read failed', childWalletsError); dataWarnings.push('Child wallets'); }
  if (membersError) { console.error('[wallet-cards] Family members read failed', membersError); dataWarnings.push('Family members'); }
  if (cardsError) { console.error('[wallet-cards] Issued cards read failed', cardsError); dataWarnings.push('Issued cards'); }

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
    <div>
      {dataWarnings.length > 0 && (
        <div role="status" aria-label={t('walletCards.walletCardsDataHealth')} className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{t('walletCards.someCardDetailsAreTemporarilyUnavailable')} {dataWarnings.join(', ')}.</p>
        </div>
      )}
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
    </div>
  );
}
