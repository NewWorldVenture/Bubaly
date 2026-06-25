import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { balanceFromLedger, bucketBalances, type LedgerEntry, type BucketKind } from '@/lib/wallet/ledger';
import { ChildDetailView } from '@/components/wallet/child-detail-view';

export const metadata: Metadata = { title: 'Child Wallet' };

export default async function ChildWalletPage({ params }: { params: Promise<{ childId: string }> }) {
  const { childId } = await params;
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: cw } = await supabase
    .from('child_wallets').select('id, member_id, is_active').eq('id', childId).eq('family_id', familyId).maybeSingle();
  if (!cw) notFound();

  const [{ data: member }, { data: buckets }, { data: txns }, { data: goals }] = await Promise.all([
    supabase.from('family_members').select('display_name').eq('id', cw.member_id).maybeSingle(),
    supabase.from('wallet_buckets').select('id, kind').eq('family_id', familyId).eq('child_wallet_id', cw.id),
    supabase.from('wallet_transactions').select('id, child_wallet_id, type, status, direction, amount_cents, description, created_at, bucket_id').eq('family_id', familyId).eq('child_wallet_id', cw.id).order('created_at', { ascending: false }).limit(1000),
    supabase.from('wallet_goals').select('id, title, target_cents, saved_cents, status').eq('family_id', familyId).eq('child_wallet_id', cw.id).order('created_at', { ascending: false }),
  ]);

  const bucketKindById = new Map((buckets ?? []).map((b) => [b.id, b.kind as BucketKind]));
  const entries: LedgerEntry[] = (txns ?? []).map((t) => ({
    direction: t.direction, amount_cents: t.amount_cents, status: t.status,
    bucket_kind: t.bucket_id ? bucketKindById.get(t.bucket_id) ?? null : null,
  }));

  const child = {
    id: cw.id,
    name: member?.display_name ?? 'Child',
    total: balanceFromLedger(entries),
    buckets: bucketBalances(entries),
  };
  const history = (txns ?? []).map((t) => ({
    id: t.id, child_wallet_id: t.child_wallet_id, type: t.type, status: t.status,
    direction: t.direction, amount_cents: t.amount_cents, description: t.description, created_at: t.created_at,
  }));

  return <ChildDetailView child={child} goals={goals ?? []} history={history} canManage={isManager(ctx.active.role)} />;
}
