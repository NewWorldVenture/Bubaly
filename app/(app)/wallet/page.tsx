import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { planLevel } from '@/lib/constants/plans';
import { walletTierForPlanLevel } from '@/lib/wallet/tiers';
import { balanceFromLedger, bucketBalances, type LedgerEntry, type BucketKind } from '@/lib/wallet/ledger';
import { WalletActivation } from '@/components/wallet/wallet-activation';
import { WalletDashboard, type ChildWalletView, type WalletAnalytics } from '@/components/wallet/wallet-dashboard';

export const metadata: Metadata = { title: 'Family Wallet' };

export default async function WalletPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const manager = isManager(ctx.active.role);
  const supabase = await createServer();

  const { data: wallet } = await supabase
    .from('family_wallets')
    .select('id, is_active, mode')
    .eq('family_id', familyId)
    .maybeSingle();

  if (!wallet || !wallet.is_active) {
    return <WalletActivation canActivate={manager} />;
  }

  const [{ data: childWallets }, { data: buckets }, { data: txns }, { data: members }, { data: sub }, { data: approvals }] = await Promise.all([
    supabase.from('child_wallets').select('id, member_id, is_active').eq('family_id', familyId).eq('is_active', true),
    supabase.from('wallet_buckets').select('id, child_wallet_id, kind, label, sort_order').eq('family_id', familyId),
    supabase.from('wallet_transactions').select('id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(2000),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
    supabase.from('subscriptions').select('plan, status').eq('family_id', familyId).in('status', ['active', 'trialing']).maybeSingle(),
    supabase.from('parent_approvals').select('id, kind, ref_id, amount_cents, note, requested_by, created_at').eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }).limit(50),
  ]);
  const tier = walletTierForPlanLevel(planLevel(sub?.plan ?? null));

  const bucketKindById = new Map((buckets ?? []).map((b) => [b.id, b.kind as BucketKind]));
  const memberById = new Map((members ?? []).map((m) => [m.id, m]));

  // Group ledger entries per child and compute derived balances.
  const entriesByChild = new Map<string, LedgerEntry[]>();
  for (const t of txns ?? []) {
    if (!t.child_wallet_id) continue;
    const arr = entriesByChild.get(t.child_wallet_id) ?? [];
    arr.push({ direction: t.direction, amount_cents: t.amount_cents, status: t.status, bucket_kind: t.bucket_id ? bucketKindById.get(t.bucket_id) ?? null : null });
    entriesByChild.set(t.child_wallet_id, arr);
  }

  const childViews: ChildWalletView[] = (childWallets ?? []).map((cw) => {
    const entries = entriesByChild.get(cw.id) ?? [];
    const member = memberById.get(cw.member_id);
    return {
      id: cw.id,
      name: member?.display_name ?? 'Child',
      color: member?.color ?? null,
      total: balanceFromLedger(entries),
      buckets: bucketBalances(entries),
    };
  });

  const recent = (txns ?? []).slice(0, 25).map((t) => ({
    id: t.id,
    childName: t.child_wallet_id ? memberById.get((childWallets ?? []).find((c) => c.id === t.child_wallet_id)?.member_id ?? '')?.display_name ?? null : null,
    type: t.type,
    status: t.status,
    direction: t.direction,
    amount_cents: t.amount_cents,
    description: t.description,
    created_at: t.created_at,
  }));

  const familyTotal = childViews.reduce((s, c) => s + c.total, 0);

  // Pending spend-request approvals → display rows (resolve which child via the txn).
  const txnById = new Map((txns ?? []).map((t) => [t.id, t]));
  const childNameByWalletId = new Map(
    (childWallets ?? []).map((cw) => [cw.id, memberById.get(cw.member_id)?.display_name ?? 'Child']),
  );
  const pendingApprovals = (approvals ?? []).map((a) => {
    const txn = a.ref_id ? txnById.get(a.ref_id) : null;
    return {
      id: a.id,
      kind: a.kind,
      childName: txn?.child_wallet_id ? childNameByWalletId.get(txn.child_wallet_id) ?? null : null,
      amount_cents: a.amount_cents ?? txn?.amount_cents ?? 0,
      note: a.note ?? txn?.description ?? null,
      created_at: a.created_at,
    };
  });

  // Spending analytics — computed from the already-fetched ledger data.
  const now = new Date();
  const thisMonthYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const completedTxns = (txns ?? []).filter((t) => t.status === 'completed');
  const thisMonthTxns = completedTxns.filter((t) => t.created_at.slice(0, 7) === thisMonthYM);

  const thisMonthIn = thisMonthTxns.filter((t) => t.direction === 'credit').reduce((s, t) => s + t.amount_cents, 0);
  const thisMonthOut = thisMonthTxns.filter((t) => t.direction === 'debit').reduce((s, t) => s + t.amount_cents, 0);

  const creditsByType: Record<string, number> = {};
  for (const t of thisMonthTxns.filter((t) => t.direction === 'credit')) {
    creditsByType[t.type] = (creditsByType[t.type] ?? 0) + t.amount_cents;
  }

  const monthlyTrend: WalletAnalytics['monthlyTrend'] = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-US', { month: 'short' });
    const mTxns = completedTxns.filter((t) => t.created_at.slice(0, 7) === ym);
    return {
      label,
      credits: mTxns.filter((t) => t.direction === 'credit').reduce((s, t) => s + t.amount_cents, 0),
      debits: mTxns.filter((t) => t.direction === 'debit').reduce((s, t) => s + t.amount_cents, 0),
    };
  }).reverse();

  const analytics: WalletAnalytics = { thisMonthIn, thisMonthOut, creditsByType, monthlyTrend };

  return (
    <WalletDashboard
      familyTotal={familyTotal}
      mode={wallet.mode}
      tier={tier}
      canManage={manager}
      childWallets={childViews}
      recent={recent}
      pendingApprovals={pendingApprovals}
      analytics={analytics}
    />
  );
}
