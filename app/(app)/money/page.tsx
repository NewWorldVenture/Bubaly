import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withStripeTables, type StripeTables } from '@/lib/supabase/stripe-tables';
import { isManager } from '@/lib/constants/roles';
import { planLevel } from '@/lib/constants/plans';
import { walletTierForPlanLevel } from '@/lib/wallet/tiers';
import { getOrRefreshCapabilities, EMPTY_CAPABILITIES } from '@/lib/stripe/capabilities';
import { MoneyDashboard } from '@/components/money/money-dashboard';

export const metadata: Metadata = { title: 'Bubaly Money' };

export default async function MoneyPage({
  searchParams,
}: {
  searchParams: Promise<{ topup?: string }>;
}) {
  const { topup } = await searchParams;
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const manager = isManager(ctx.active.role);
  const supabase = await createServer();
  const db = withStripeTables(supabase);

  const [
    { data: connectedAccount },
    { data: sub },
    { data: childWallets },
    { data: members },
    { data: cards },
    { data: recentTxns },
    { data: authorizations },
  ] = await Promise.all([
    db.from('stripe_connected_accounts').select('account_id, status, charges_enabled, payouts_enabled').eq('family_id', familyId).maybeSingle(),
    supabase.from('subscriptions').select('plan, status').eq('family_id', familyId).in('status', ['active', 'trialing']).maybeSingle(),
    supabase.from('child_wallets').select('id, member_id, is_active').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_members').select('id, display_name, color, role').eq('family_id', familyId).eq('is_active', true),
    db.from('stripe_issuing_cards').select('id, card_id, child_wallet_id, type, status, last4, brand, cardholder_id').eq('family_id', familyId).neq('status', 'canceled'),
    supabase.from('wallet_transactions').select('id, child_wallet_id, type, direction, amount_cents, description, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(20),
    db.from('stripe_authorizations').select('id, authorization_id, card_id, status, decision, amount_cents, merchant_name, merchant_category, authorized_at').eq('family_id', familyId).order('authorized_at', { ascending: false }).limit(10),
  ]);

  const tier = walletTierForPlanLevel(planLevel(sub?.plan ?? null));

  // Load capabilities (cached, 30-min TTL)
  let capabilities = EMPTY_CAPABILITIES;
  try {
    capabilities = await getOrRefreshCapabilities(supabase, familyId, connectedAccount?.account_id ?? null);
  } catch { /* use empty caps */ }

  type StripCard = StripeTables['stripe_issuing_cards'];
  type StripeAuth = StripeTables['stripe_authorizations'];
  const memberById = new Map((members ?? []).map((m) => [m.id, m]));
  const typedCards = (cards ?? []) as StripCard[];
  const cardsByWallet = new Map<string, StripCard[]>();
  for (const card of typedCards) {
    if (!card.child_wallet_id) continue;
    if (!cardsByWallet.has(card.child_wallet_id)) cardsByWallet.set(card.child_wallet_id, []);
    cardsByWallet.get(card.child_wallet_id)!.push(card);
  }

  // Compute wallet totals from recent transactions
  const walletBalances = new Map<string, number>();
  const { data: allTxns } = await supabase
    .from('wallet_transactions')
    .select('child_wallet_id, direction, amount_cents, status')
    .eq('family_id', familyId);

  for (const txn of allTxns ?? []) {
    if (txn.status !== 'completed' || !txn.child_wallet_id) continue;
    const curr = walletBalances.get(txn.child_wallet_id) ?? 0;
    walletBalances.set(
      txn.child_wallet_id,
      curr + (txn.direction === 'credit' ? txn.amount_cents : -txn.amount_cents),
    );
  }

  const walletViews = (childWallets ?? []).map((cw) => {
    const member = memberById.get(cw.member_id);
    return {
      id: cw.id,
      memberId: cw.member_id,
      memberName: member?.display_name ?? 'Child',
      memberColor: member?.color ?? null,
      balanceCents: walletBalances.get(cw.id) ?? 0,
      cards: ((cardsByWallet.get(cw.id) ?? []) as StripCard[]).map((c) => ({
        cardId: c.card_id,
        type: c.type as 'virtual' | 'physical',
        status: c.status as 'active' | 'inactive' | 'canceled',
        last4: c.last4,
        brand: c.brand,
      })),
    };
  });

  return (
    <MoneyDashboard
      manager={manager}
      tier={tier}
      capabilities={capabilities}
      connectedAccount={connectedAccount ?? null}
      topupSuccess={topup === 'success'}
      wallets={walletViews}
      recentTransactions={(recentTxns ?? []).map((t) => ({
        id: t.id,
        childWalletId: t.child_wallet_id ?? '',
        type: t.type,
        direction: t.direction as 'credit' | 'debit',
        amountCents: t.amount_cents,
        description: t.description ?? '',
        createdAt: t.created_at,
      }))}
      recentAuthorizations={((authorizations ?? []) as StripeAuth[]).map((a) => ({
        id: a.id,
        authorizationId: a.authorization_id,
        cardId: a.card_id,
        status: a.status as 'pending' | 'approved' | 'declined' | 'reversed' | 'closed',
        decision: a.decision as 'approved' | 'declined' | null,
        amountCents: a.amount_cents,
        merchantName: a.merchant_name,
        merchantCategory: a.merchant_category,
        authorizedAt: a.authorized_at,
      }))}
    />
  );
}
