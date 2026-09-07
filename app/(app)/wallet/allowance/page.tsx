import type { Metadata } from 'next';
import { AlertTriangle } from 'lucide-react';
import { requireUserContext, effectivePlanLevel } from '@/lib/supabase/auth';
import { settle } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { walletTierForPlanLevel, walletFeatureEnabled } from '@/lib/wallet/tiers';
import { AllowanceView, type AllowanceRow } from '@/components/wallet/allowance-view';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Wallet Allowance' };

export default async function WalletAllowancePage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const dataWarnings: string[] = [];

  const [{ data: childWallets, error: childWalletsError }, { data: members, error: membersError }, { data: rules, error: rulesError }, famPlanLevel] = await Promise.all([
    settle(supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true)),
    settle(supabase.from('family_members').select('id, display_name').eq('family_id', familyId)),
    settle(supabase.from('allowance_rules').select('id, child_wallet_id, amount_cents, cadence, is_active, next_run_on').eq('family_id', familyId)),
    resolveFamilyPlanLevel(supabase, familyId),
  ]);
  if (childWalletsError) {
    console.error('[wallet-allowance] Child wallets read failed', childWalletsError);
    return <ErrorState message={t('allowance.couldNotLoadWalletAllowance')} />;
  }
  if (membersError) { console.error('[wallet-allowance] Family members read failed', membersError); dataWarnings.push('Family members'); }
  if (rulesError) { console.error('[wallet-allowance] Allowance rules read failed', rulesError); dataWarnings.push('Allowance rules'); }

  const nameByMember = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const ruleByWallet = new Map((rules ?? []).map((r) => [r.child_wallet_id, r]));

  const rows: AllowanceRow[] = (childWallets ?? []).map((cw) => {
    const r = ruleByWallet.get(cw.id);
    return {
      childWalletId: cw.id,
      name: nameByMember.get(cw.member_id) ?? 'Child',
      ruleId: r?.id ?? null,
      amountCents: r?.amount_cents ?? 0,
      cadence: (r?.cadence ?? 'weekly') as AllowanceRow['cadence'],
      isActive: r?.is_active ?? false,
      nextRunOn: r?.next_run_on ?? null,
    };
  });

  const tier = walletTierForPlanLevel(await effectivePlanLevel(famPlanLevel));
  return (
    <div>
      {dataWarnings.length > 0 && (
        <div role="status" aria-label={t('walletAllowance.walletAllowanceDataHealth')} className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{t('walletAllowance.someAllowanceDetailsAreTemporarilyUnavailable')} {dataWarnings.join(', ')}.</p>
        </div>
      )}
      <AllowanceView rows={rows} enabled={walletFeatureEnabled(tier, 'allowances')} canManage={isManager(ctx.active.role)} />
    </div>
  );
}
