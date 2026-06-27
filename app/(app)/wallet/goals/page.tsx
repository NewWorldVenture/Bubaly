import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { weeksToGoal } from '@/lib/wallet/ledger';
import { GoalsView, type GoalView, type ChildOption } from '@/components/wallet/goals-view';

export const metadata: Metadata = { title: 'Wallet Goals' };

export default async function WalletGoalsPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  // Fetch goals, wallets, members, and recent save-bucket credits (last 8 weeks)
  // to compute a per-child weekly save rate for goal forecasts.
  const since = new Date(Date.now() - 56 * 86400000).toISOString();
  const [{ data: goals }, { data: childWallets }, { data: members }, { data: walletBuckets }, { data: recentTxns }] = await Promise.all([
    supabase.from('wallet_goals').select('id, child_wallet_id, title, kind, target_cents, saved_cents, target_date, status').eq('family_id', familyId).order('created_at', { ascending: false }),
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId),
    supabase.from('wallet_buckets').select('id, kind, child_wallet_id').eq('family_id', familyId).eq('kind', 'save'),
    supabase.from('wallet_transactions').select('child_wallet_id, bucket_id, amount_cents').eq('family_id', familyId).eq('direction', 'credit').eq('status', 'completed').gte('created_at', since),
  ]);

  const nameByMember = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const nameByWallet = new Map((childWallets ?? []).map((c) => [c.id, nameByMember.get(c.member_id) ?? 'Child']));

  // Save bucket IDs per child wallet
  const saveBucketByWallet = new Map((walletBuckets ?? []).map((b) => [b.child_wallet_id, b.id]));

  // Weekly save rate per child (credits into save bucket over last 8 weeks / 8)
  const recentSaveByWallet = new Map<string, number>();
  for (const t of recentTxns ?? []) {
    if (!t.child_wallet_id) continue;
    const saveBucketId = saveBucketByWallet.get(t.child_wallet_id);
    if (saveBucketId && t.bucket_id === saveBucketId) {
      recentSaveByWallet.set(t.child_wallet_id, (recentSaveByWallet.get(t.child_wallet_id) ?? 0) + t.amount_cents);
    }
  }

  const goalViews: GoalView[] = (goals ?? []).map((g) => {
    const weeklyRate = g.child_wallet_id ? Math.round((recentSaveByWallet.get(g.child_wallet_id) ?? 0) / 8) : 0;
    return {
      id: g.id, title: g.title, kind: g.kind,
      targetCents: g.target_cents, savedCents: g.saved_cents,
      targetDate: g.target_date ?? null,
      childName: g.child_wallet_id ? nameByWallet.get(g.child_wallet_id) ?? null : null,
      isChildGoal: !!g.child_wallet_id, status: g.status,
      weeklyRateCents: weeklyRate,
      weeksToGoal: weeksToGoal(g.saved_cents, g.target_cents, weeklyRate),
    };
  });
  const childOptions: ChildOption[] = (childWallets ?? []).map((c) => ({ id: c.id, name: nameByMember.get(c.member_id) ?? 'Child' }));

  return <GoalsView goals={goalViews} childOptions={childOptions} canManage={isManager(ctx.active.role)} />;
}
