import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { ErrorState } from '@/components/ui/states';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { normalizeSplit } from '@/lib/wallet/ledger';
import { WalletSettingsView, type ChildRuleRow } from '@/components/wallet/wallet-settings-view';

export const metadata: Metadata = { title: 'Wallet Settings' };

export default async function WalletSettingsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [{ data: childWallets, error: childWalletsError }, { data: members, error: membersError }, { data: rules, error: rulesError }] = await Promise.all([
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
    supabase.from('wallet_rules').select('child_wallet_id, split, auto_accept_gifts, require_approval_over_cents').eq('family_id', familyId),
  ]);
  if (childWalletsError || membersError || rulesError) {
    console.error('[wallet-settings] Read failed', childWalletsError ?? membersError ?? rulesError);
    return <ErrorState message={t('settings.couldNotLoadWalletSettings')} />;
  }

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));
  const ruleByWallet = new Map((rules ?? []).map((r) => [r.child_wallet_id, r]));

  const rows: ChildRuleRow[] = (childWallets ?? []).map((cw) => {
    const r = ruleByWallet.get(cw.id);
    const m = memberById.get(cw.member_id);
    return {
      childWalletId: cw.id,
      name: m?.display_name ?? 'Child',
      color: m?.color ?? null,
      split: normalizeSplit((r?.split as Record<string, number> | null) ?? null),
      autoAcceptGifts: r?.auto_accept_gifts ?? false,
      requireApprovalOverCents: r?.require_approval_over_cents ?? 5000,
    };
  });

  return <WalletSettingsView rows={rows} canManage={isManager(ctx.active.role)} />;
}
