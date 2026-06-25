import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { WalletActivation } from '@/components/wallet/wallet-activation';
import { WalletActivityView } from '@/components/wallet/activity-view';
import { isManager } from '@/lib/constants/roles';

export const metadata: Metadata = { title: 'Wallet Activity' };

export default async function WalletActivityPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: wallet } = await supabase
    .from('family_wallets').select('id, is_active').eq('family_id', familyId).maybeSingle();
  if (!wallet || !wallet.is_active) return <WalletActivation canActivate={isManager(ctx.active.role)} />;

  const [{ data: childWallets }, { data: txns }, { data: members }] = await Promise.all([
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId),
    supabase.from('wallet_transactions').select('id, child_wallet_id, type, status, direction, amount_cents, description, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(2000),
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId),
  ]);

  const memberById = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const childName = new Map((childWallets ?? []).map((c) => [c.id, memberById.get(c.member_id) ?? 'Child']));

  const rows = (txns ?? []).map((t) => ({
    id: t.id, child_wallet_id: t.child_wallet_id, type: t.type, status: t.status, direction: t.direction,
    amount_cents: t.amount_cents, description: t.description, created_at: t.created_at,
    childName: t.child_wallet_id ? childName.get(t.child_wallet_id) ?? null : null,
  }));
  const childOptions = (childWallets ?? []).map((c) => ({ id: c.id, name: memberById.get(c.member_id) ?? 'Child' }));

  return <WalletActivityView rows={rows} childOptions={childOptions} />;
}
