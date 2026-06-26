import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { normalizeSplit, type Split } from '@/lib/wallet/ledger';
import { WalletActivation } from '@/components/wallet/wallet-activation';
import { WalletSettingsView, type SplitChild } from '@/components/wallet/settings-view';

export const metadata: Metadata = { title: 'Wallet Allocation' };

export default async function WalletSettingsPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: wallet } = await supabase
    .from('family_wallets').select('id, is_active').eq('family_id', familyId).maybeSingle();
  if (!wallet || !wallet.is_active) return <WalletActivation canActivate={isManager(ctx.active.role)} />;

  const [{ data: childWallets }, { data: rules }, { data: members }] = await Promise.all([
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('wallet_rules').select('child_wallet_id, split').eq('family_id', familyId),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
  ]);

  const splitByChild = new Map((rules ?? []).map((r) => [r.child_wallet_id, r.split as Partial<Split> | null]));
  const memberById = new Map((members ?? []).map((m) => [m.id, m]));

  const children: SplitChild[] = (childWallets ?? []).map((cw) => {
    const m = memberById.get(cw.member_id);
    return {
      id: cw.id,
      name: m?.display_name ?? 'Child',
      color: m?.color ?? null,
      split: normalizeSplit(splitByChild.get(cw.id)),
    };
  });

  return <WalletSettingsView childWallets={children} canManage={isManager(ctx.active.role)} />;
}
