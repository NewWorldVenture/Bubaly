import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { normalizeSplit } from '@/lib/wallet/ledger';
import { WalletSettingsView, type ChildWalletRule } from '@/components/wallet/wallet-settings-view';

export const metadata: Metadata = { title: 'Wallet Settings — Bubaly' };

export default async function WalletSettingsPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const canManage = isManager(ctx.active.role);
  const supabase = await createServer();

  const [{ data: childWallets }, { data: members }, { data: ruleRows }] = await Promise.all([
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    supabase.from('wallet_rules').select('child_wallet_id, split, auto_accept_gifts, require_approval_over_cents')
      .eq('family_id', familyId),
  ]);

  const nameByMember = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const ruleByWallet = new Map((ruleRows ?? []).map((r) => [r.child_wallet_id, r]));

  const rules: ChildWalletRule[] = (childWallets ?? []).map((cw) => {
    const rule = ruleByWallet.get(cw.id);
    return {
      childWalletId: cw.id,
      name: nameByMember.get(cw.member_id) ?? 'Child',
      split: normalizeSplit(rule?.split as Parameters<typeof normalizeSplit>[0]),
      autoAcceptGifts: rule?.auto_accept_gifts ?? false,
      requireApprovalOverCents: rule?.require_approval_over_cents ?? 5000,
    };
  });

  return <WalletSettingsView rules={rules} canManage={canManage} />;
}
