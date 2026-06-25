import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { GoalsView, type GoalView, type ChildOption } from '@/components/wallet/goals-view';

export const metadata: Metadata = { title: 'Wallet Goals' };

export default async function WalletGoalsPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [{ data: goals }, { data: childWallets }, { data: members }] = await Promise.all([
    supabase.from('wallet_goals').select('id, child_wallet_id, title, kind, target_cents, saved_cents, target_date, status').eq('family_id', familyId).order('created_at', { ascending: false }),
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId),
  ]);

  const nameByMember = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const nameByWallet = new Map((childWallets ?? []).map((c) => [c.id, nameByMember.get(c.member_id) ?? 'Child']));

  const goalViews: GoalView[] = (goals ?? []).map((g) => ({
    id: g.id, title: g.title, kind: g.kind,
    targetCents: g.target_cents, savedCents: g.saved_cents,
    childName: g.child_wallet_id ? nameByWallet.get(g.child_wallet_id) ?? null : null,
    isChildGoal: !!g.child_wallet_id, status: g.status,
  }));
  const childOptions: ChildOption[] = (childWallets ?? []).map((c) => ({ id: c.id, name: nameByMember.get(c.member_id) ?? 'Child' }));

  return <GoalsView goals={goalViews} childOptions={childOptions} canManage={isManager(ctx.active.role)} />;
}
