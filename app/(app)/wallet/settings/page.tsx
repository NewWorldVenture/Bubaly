import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { ErrorState } from '@/components/ui/states';
import { requireUserContext } from '@/lib/supabase/auth';
import { refuseGuest } from '@/lib/auth/guest-scope';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { normalizeSplit } from '@/lib/wallet/ledger';
import { WalletSettingsView, type ChildRuleRow } from '@/components/wallet/wallet-settings-view';
import { inWalletScope, ownMemberOnly, readWalletScope } from '@/lib/wallet/own-wallets';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.walletSettings') };
}

export default async function WalletSettingsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext(); refuseGuest(ctx, '/wallet/settings');
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  // The held 0515: a child's wallet rules are read by a parent or adult and by
  // that child, so anyone else's page reads their own wallet's.
  const { scope, error: scopeError } = await readWalletScope(supabase, ctx);
  if (scopeError) {
    console.error('[wallet-settings] Own wallet read failed', scopeError);
    return <ErrorState message={t('settings.couldNotLoadWalletSettings')} />;
  }

  const [{ data: childWallets, error: childWalletsError }, { data: members, error: membersError }, { data: rules, error: rulesError }] = await settleAll([
    ownMemberOnly(supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true), scope, ctx.active.member.id),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
    inWalletScope(supabase.from('wallet_rules').select('child_wallet_id, split, auto_accept_gifts, require_approval_over_cents').eq('family_id', familyId), scope),
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

  return (
    <>
      {!scope.all && <p className="mb-3 text-xs text-muted">{t('childMoney.onlyYourOwnWallet')}</p>}
      <WalletSettingsView rows={rows} canManage={isManager(ctx.active.role)} />
    </>
  );
}
