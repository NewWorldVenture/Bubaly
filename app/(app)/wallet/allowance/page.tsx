import type { Metadata } from 'next';
import { requireUserContext, effectivePlanLevel } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { walletTierForPlanLevel, walletFeatureEnabled } from '@/lib/wallet/tiers';
import { AllowanceView, type AllowanceRow } from '@/components/wallet/allowance-view';

export const metadata: Metadata = { title: 'Wallet Allowance' };

export default async function WalletAllowancePage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [{ data: childWallets }, { data: members }, { data: rules }, famPlanLevel] = await Promise.all([
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId),
    supabase.from('allowance_rules').select('id, child_wallet_id, amount_cents, cadence, is_active, next_run_on').eq('family_id', familyId),
    resolveFamilyPlanLevel(supabase, familyId),
  ]);

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
  return <AllowanceView rows={rows} enabled={walletFeatureEnabled(tier, 'allowances')} canManage={isManager(ctx.active.role)} />;
}
