import type { Metadata } from 'next';
import { AlertTriangle } from 'lucide-react';
import { requireUserContext, effectivePlanLevel } from '@/lib/supabase/auth';
import { refuseGuest } from '@/lib/auth/guest-scope';
import { settle } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { walletTierForPlanLevel, walletFeatureEnabled } from '@/lib/wallet/tiers';
import { AllowanceView, type AllowanceRow } from '@/components/wallet/allowance-view';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';
import { inWalletScope, ownMemberOnly, readWalletScope } from '@/lib/wallet/own-wallets';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.walletAllowance') };
}

export default async function WalletAllowancePage() {
  const t = await getTranslations();
  const ctx = await requireUserContext(); refuseGuest(ctx, '/wallet/allowance');
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const dataWarnings: string[] = [];

  // The held 0515: a child's money is read by a parent or adult and by that
  // child, so anyone else's page reads their own wallet's, narrowed in the query.
  const { scope, error: scopeError } = await readWalletScope(supabase, ctx);
  if (scopeError) {
    console.error('[wallet-allowance] Own wallet read failed', scopeError);
    return <ErrorState message={t('allowance.couldNotLoadWalletAllowance')} />;
  }

  const [{ data: childWallets, error: childWalletsError }, { data: members, error: membersError }, { data: rules, error: rulesError }, famPlanLevel] = await Promise.all([
    settle(ownMemberOnly(supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true), scope, ctx.active.member.id)),
    settle(supabase.from('family_members').select('id, display_name').eq('family_id', familyId)),
    settle(inWalletScope(supabase.from('allowance_rules').select('id, child_wallet_id, amount_cents, cadence, is_active, next_run_on').eq('family_id', familyId), scope)),
    resolveFamilyPlanLevel(supabase, familyId),
  ]);
  if (childWalletsError) {
    console.error('[wallet-allowance] Child wallets read failed', childWalletsError);
    return <ErrorState message={t('allowance.couldNotLoadWalletAllowance')} />;
  }
  if (membersError) { console.error('[wallet-allowance] Family members read failed', membersError); dataWarnings.push('Family members'); }
  if (rulesError) { console.error('[wallet-allowance] Allowance rules read failed', rulesError); dataWarnings.push('Allowance rules'); }

  const nameByMember = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  // EVERY rule a wallet has, not the last one a Map kept. The cron and Run due
  // now pay each active due rule, so a child holding two (saved from two views
  // of this page before the action refused a second) was paid by both while
  // this page showed, counted and paused one. Each rule gets its own row here,
  // so the one nobody could see can be seen and paused.
  const rulesByWallet = new Map<string, NonNullable<typeof rules>>();
  for (const r of rules ?? []) rulesByWallet.set(r.child_wallet_id, [...(rulesByWallet.get(r.child_wallet_id) ?? []), r]);

  const rows: AllowanceRow[] = (childWallets ?? []).flatMap((cw) => {
    const walletRules = rulesByWallet.get(cw.id) ?? [];
    // "Each one is paid. Pause the one you do not want." is true of the ACTIVE
    // rules only: once the parent paused the extra one, one rule paid and both
    // rows still told them to pause one (M2-UX). The paused rule keeps its row.
    const paying = walletRules.filter((r) => r.is_active).length;
    return (walletRules.length ? walletRules : [null]).map((r) => ({
      childWalletId: cw.id,
      name: nameByMember.get(cw.member_id) ?? 'Child',
      ruleId: r?.id ?? null,
      amountCents: r?.amount_cents ?? 0,
      cadence: (r?.cadence ?? 'weekly') as AllowanceRow['cadence'],
      isActive: r?.is_active ?? false,
      nextRunOn: r?.next_run_on ?? null,
      duplicate: (r?.is_active ?? false) && paying > 1,
    }));
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
      {!scope.all && <p className="mb-3 text-xs text-muted">{t('childMoney.onlyYourOwnWallet')}</p>}
      <AllowanceView rows={rows} enabled={walletFeatureEnabled(tier, 'allowances')} canManage={isManager(ctx.active.role)} />
    </div>
  );
}
