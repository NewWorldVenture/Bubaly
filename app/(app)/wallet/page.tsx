import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { planLevel } from '@/lib/constants/plans';
import { walletTierForPlanLevel, aiCoachLevel, AI_COACH_DAILY_LIMIT } from '@/lib/wallet/tiers';
import { balanceFromLedger, bucketBalances, type LedgerEntry, type BucketKind } from '@/lib/wallet/ledger';
import { WalletActivation } from '@/components/wallet/wallet-activation';
import { WalletDashboard, type ChildWalletView } from '@/components/wallet/wallet-dashboard';

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

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const [{ data: childWallets }, { data: buckets }, { data: txns }, { data: members }, { data: sub }, { count: coachCallsToday }] = await Promise.all([
    supabase.from('child_wallets').select('id, member_id, is_active').eq('family_id', familyId).eq('is_active', true),
    supabase.from('wallet_buckets').select('id, child_wallet_id, kind, label, sort_order').eq('family_id', familyId),
    supabase.from('wallet_transactions').select('id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(2000),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
    supabase.from('subscriptions').select('plan, status').eq('family_id', familyId).in('status', ['active', 'trialing']).maybeSingle(),
    supabase.from('wallet_audit_logs').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('action', 'ai_coach_call').gte('created_at', todayStart.toISOString()),
  ]);
  const tier = walletTierForPlanLevel(planLevel(sub?.plan ?? null));
  const coachLevel = aiCoachLevel(tier);
  const coachDailyLimit = AI_COACH_DAILY_LIMIT[tier];

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

  return (
    <WalletDashboard
      familyTotal={familyTotal}
      mode={wallet.mode}
      tier={tier}
      canManage={manager}
      childWallets={childViews}
      recent={recent}
      coachCallsToday={coachCallsToday ?? 0}
      coachDailyLimit={Number.isFinite(coachDailyLimit) ? coachDailyLimit : null}
      coachLevel={coachLevel}
    />
  );
}
