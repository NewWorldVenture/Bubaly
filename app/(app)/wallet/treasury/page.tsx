import type { Metadata } from 'next';
import { AlertTriangle } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { balanceFromLedger, bucketBalances, type LedgerEntry, type BucketKind } from '@/lib/wallet/ledger';
import { WalletActivation } from '@/components/wallet/wallet-activation';
import { TreasuryView, type TreasuryChild } from '@/components/wallet/treasury-view';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Family Treasury' };
export const dynamic = 'force-dynamic';

export default async function WalletTreasuryPage() {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const dataWarnings: string[] = [];

  const { data: wallet, error: walletError } = await supabase
    .from('family_wallets').select('id, is_active').eq('family_id', familyId).maybeSingle();
  if (walletError) {
    console.error('[wallet-treasury] Wallet read failed', walletError);
    return <ErrorState message={tr('treasury.couldNotLoadTheFamily')} />;
  }
  if (!wallet || !wallet.is_active) return <WalletActivation canActivate={isManager(ctx.active.role)} />;

  const [{ data: childWallets, error: childWalletsError }, { data: buckets, error: bucketsError }, { data: txns, error: txnsError }, { data: members, error: membersError }, { data: goals, error: goalsError }, { data: rules, error: rulesError }] = await Promise.all([
    supabase.from('child_wallets').select('id, member_id, is_active').eq('family_id', familyId).eq('is_active', true),
    supabase.from('wallet_buckets').select('id, child_wallet_id, kind').eq('family_id', familyId),
    supabase.from('wallet_transactions')
      .select('id, child_wallet_id, bucket_id, type, status, direction, amount_cents, created_at')
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(5000),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
    supabase.from('wallet_goals')
      .select('id, child_wallet_id, title, target_cents, saved_cents, status, kind')
      .eq('family_id', familyId),
    supabase.from('wallet_rules')
      .select('child_wallet_id, split')
      .eq('family_id', familyId),
  ]);
  if (childWalletsError) { console.error('[wallet-treasury] Child wallets read failed', childWalletsError); dataWarnings.push('Child wallets'); }
  if (bucketsError) { console.error('[wallet-treasury] Wallet buckets read failed', bucketsError); dataWarnings.push('Wallet buckets'); }
  if (txnsError) { console.error('[wallet-treasury] Wallet transactions read failed', txnsError); dataWarnings.push('Wallet transactions'); }
  if (membersError) { console.error('[wallet-treasury] Family members read failed', membersError); dataWarnings.push('Family members'); }
  if (goalsError) { console.error('[wallet-treasury] Wallet goals read failed', goalsError); dataWarnings.push('Wallet goals'); }
  if (rulesError) { console.error('[wallet-treasury] Wallet rules read failed', rulesError); dataWarnings.push('Wallet rules'); }

  const bucketKindById = new Map((buckets ?? []).map((b) => [b.id, b.kind as BucketKind]));
  const memberById = new Map((members ?? []).map((m) => [m.id, m]));

  const entriesByChild = new Map<string, LedgerEntry[]>();
  for (const t of txns ?? []) {
    if (!t.child_wallet_id) continue;
    const arr = entriesByChild.get(t.child_wallet_id) ?? [];
    arr.push({ direction: t.direction, amount_cents: t.amount_cents, status: t.status, bucket_kind: t.bucket_id ? bucketKindById.get(t.bucket_id) ?? null : null });
    entriesByChild.set(t.child_wallet_id, arr);
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  let thisMonthIn = 0, thisMonthOut = 0;
  for (const t of txns ?? []) {
    if (t.created_at < monthStart || t.status !== 'completed') continue;
    if (t.direction === 'credit') thisMonthIn += t.amount_cents;
    else thisMonthOut += t.amount_cents;
  }

  const children: TreasuryChild[] = (childWallets ?? []).map((cw) => {
    const entries = entriesByChild.get(cw.id) ?? [];
    const member = memberById.get(cw.member_id);
    const total = balanceFromLedger(entries);
    const childBuckets = bucketBalances(entries);
    const childGoals = (goals ?? []).filter((g) => g.child_wallet_id === cw.id);
    const activeGoals = childGoals.filter((g) => g.status !== 'reached');
    const monthlyTxns = (txns ?? []).filter((t) => t.child_wallet_id === cw.id && t.created_at >= monthStart && t.status === 'completed');
    const monthlyIn = monthlyTxns.filter((t) => t.direction === 'credit').reduce((s, t) => s + t.amount_cents, 0);
    const monthlyOut = monthlyTxns.filter((t) => t.direction === 'debit').reduce((s, t) => s + t.amount_cents, 0);
    return {
      id: cw.id,
      name: member?.display_name ?? 'Child',
      color: member?.color ?? null,
      total,
      buckets: childBuckets,
      activeGoals: activeGoals.length,
      goalSavedCents: activeGoals.reduce((s, g) => s + (g.saved_cents ?? 0), 0),
      goalTargetCents: activeGoals.reduce((s, g) => s + g.target_cents, 0),
      monthlyIn,
      monthlyOut,
    };
  });

  const familyTotal = children.reduce((sum, c) => sum + c.total, 0);
  const totalGoalSaved = children.reduce((sum, c) => sum + c.goalSavedCents, 0);
  const totalGoalTargets = children.reduce((sum, c) => sum + c.goalTargetCents, 0);
  const totalActiveGoals = children.reduce((sum, c) => sum + c.activeGoals, 0);

  // 6-month monthly trend
  const trend: { label: string; credits: number; debits: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const start = d.toISOString().slice(0, 10);
    const nextM = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const end = new Date(nextM.getTime() - 1).toISOString().slice(0, 10);
    let credits = 0, debits = 0;
    for (const t of txns ?? []) {
      const ds = t.created_at.slice(0, 10);
      if (ds < start || ds > end || t.status !== 'completed') continue;
      if (t.direction === 'credit') credits += t.amount_cents;
      else debits += t.amount_cents;
    }
    trend.push({ label: d.toLocaleDateString('en-US', { month: 'short' }), credits, debits });
  }

  return (
    <div>
      {dataWarnings.length > 0 && (
        <div role="status" aria-label={tr('walletTreasury.walletTreasuryDataHealth')} className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{tr('walletTreasury.someTreasuryDetailsAreTemporarilyUnavailable')} {dataWarnings.join(', ')}.</p>
        </div>
      )}
      <TreasuryView
        familyTotal={familyTotal}
        wallets={children}
        thisMonthIn={thisMonthIn}
        thisMonthOut={thisMonthOut}
        totalGoalSaved={totalGoalSaved}
        totalGoalTargets={totalGoalTargets}
        totalActiveGoals={totalActiveGoals}
        trend={trend}
        canManage={isManager(ctx.active.role)}
      />
    </div>
  );
}
