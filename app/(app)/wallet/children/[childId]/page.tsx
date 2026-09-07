import type { Metadata } from 'next';
import { AlertTriangle } from 'lucide-react';
import { notFound } from 'next/navigation';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { balanceFromLedger, bucketBalances, normalizeSplit, type LedgerEntry, type BucketKind } from '@/lib/wallet/ledger';
import { ChildDetailView } from '@/components/wallet/child-detail-view';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Child Wallet' };

export default async function ChildWalletPage({ params }: { params: Promise<{ childId: string }> }) {
  const tr = await getTranslations();
  const { childId } = await params;
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: cw, error: childWalletError } = await supabase
    .from('child_wallets').select('id, member_id, is_active').eq('id', childId).eq('family_id', familyId).maybeSingle();
  if (childWalletError) {
    console.error('[wallet-child] Child wallet read failed', childWalletError);
    return <ErrorState message={tr('children.couldNotLoadThisChild')} />;
  }
  if (!cw) notFound();

  const [{ data: member, error: memberError }, { data: buckets, error: bucketsError }, { data: txns, error: txnsError }, { data: goals, error: goalsError }, { data: rule, error: ruleError }, { data: allChildWallets, error: allChildWalletsError }, { data: members, error: membersError }] = await settleAll([
    supabase.from('family_members').select('display_name, color').eq('id', cw.member_id).maybeSingle(),
    supabase.from('wallet_buckets').select('id, kind').eq('family_id', familyId).eq('child_wallet_id', cw.id),
    supabase.from('wallet_transactions')
      .select('id, child_wallet_id, type, status, direction, amount_cents, description, created_at, bucket_id, metadata')
      .eq('family_id', familyId).eq('child_wallet_id', cw.id)
      .order('created_at', { ascending: false }).limit(200),
    supabase.from('wallet_goals')
      .select('id, title, target_cents, saved_cents, status, kind, target_date')
      .eq('family_id', familyId).eq('child_wallet_id', cw.id)
      .order('created_at', { ascending: false }),
    supabase.from('wallet_rules')
      .select('split, require_approval_over_cents')
      .eq('family_id', familyId).eq('child_wallet_id', cw.id).maybeSingle(),
    supabase.from('child_wallets').select('id, member_id, is_active').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
  ]);
  if (bucketsError || txnsError || ruleError) {
    console.error('[wallet-child] Balance reads failed', bucketsError ?? txnsError ?? ruleError);
    return <ErrorState message={tr('children.couldNotLoadThisChild2')} />;
  }
  const dataWarnings: string[] = [];
  if (memberError) { console.error('[wallet-child] Member read failed', memberError); dataWarnings.push('Child profile'); }
  if (goalsError) { console.error('[wallet-child] Goals read failed', goalsError); dataWarnings.push('Goals'); }
  if (allChildWalletsError) { console.error('[wallet-child] Sibling wallet read failed', allChildWalletsError); dataWarnings.push('Sibling wallets'); }
  if (membersError) { console.error('[wallet-child] Family members read failed', membersError); dataWarnings.push('Family members'); }

  const bucketKindById = new Map((buckets ?? []).map((b) => [b.id, b.kind as BucketKind]));
  const entries: LedgerEntry[] = (txns ?? []).map((t) => ({
    direction: t.direction, amount_cents: t.amount_cents, status: t.status,
    bucket_kind: t.bucket_id ? bucketKindById.get(t.bucket_id) ?? null : null,
  }));

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));

  const child = {
    id: cw.id,
    name: member?.display_name ?? 'Child',
    color: member?.color ?? null,
    total: balanceFromLedger(entries),
    buckets: bucketBalances(entries),
    split: normalizeSplit(rule?.split as Record<string, number> | null),
    approvalThresholdCents: rule?.require_approval_over_cents ?? 5000,
  };

  const history = (txns ?? []).map((t) => ({
    id: t.id, child_wallet_id: t.child_wallet_id, type: t.type, status: t.status,
    direction: t.direction, amount_cents: t.amount_cents, description: t.description,
    created_at: t.created_at,
    bucket_kind: t.bucket_id ? bucketKindById.get(t.bucket_id) ?? null : null,
    metadata: t.metadata as Record<string, unknown> | null,
  }));

  // Sibling wallets (other active child wallets) for Send Money
  const siblings = (allChildWallets ?? [])
    .filter((w) => w.id !== cw.id)
    .map((w) => {
      const m = memberById.get(w.member_id);
      return { id: w.id, name: m?.display_name ?? 'Child', color: m?.color ?? null };
    });

  return (
    <div>
      {dataWarnings.length > 0 && (
        <div role="status" aria-label={tr('walletChildren.childWalletDataHealth')} className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{tr('walletChildren.someChildWalletDetailsAreTemporarily')} {dataWarnings.join(', ')}.</p>
        </div>
      )}
      <ChildDetailView child={child} goals={goals ?? []} history={history} canManage={isManager(ctx.active.role)} siblings={siblings} />
    </div>
  );
}
