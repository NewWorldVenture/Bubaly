import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { balanceFromLedger, type LedgerEntry, type BucketKind } from '@/lib/wallet/ledger';
import { WalletActivation } from '@/components/wallet/wallet-activation';
import { SendMoneyView, type SendChild } from '@/components/wallet/send-money-view';

export const metadata: Metadata = { title: 'Send Money' };
export const dynamic = 'force-dynamic';

export default async function SendMoneyPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: wallet } = await supabase
    .from('family_wallets').select('id, is_active').eq('family_id', familyId).maybeSingle();
  if (!wallet || !wallet.is_active) return <WalletActivation canActivate={isManager(ctx.active.role)} />;

  const [{ data: childWallets }, { data: buckets }, { data: txns }, { data: members }] = await Promise.all([
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('wallet_buckets').select('id, child_wallet_id, kind').eq('family_id', familyId),
    supabase.from('wallet_transactions')
      .select('child_wallet_id, bucket_id, direction, amount_cents, status')
      .eq('family_id', familyId).limit(3000),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
  ]);

  const bucketKindById = new Map((buckets ?? []).map((b) => [b.id, b.kind as BucketKind]));
  const memberById = new Map((members ?? []).map((m) => [m.id, m]));

  const entriesByChild = new Map<string, LedgerEntry[]>();
  for (const t of txns ?? []) {
    if (!t.child_wallet_id) continue;
    const arr = entriesByChild.get(t.child_wallet_id) ?? [];
    arr.push({ direction: t.direction, amount_cents: t.amount_cents, status: t.status, bucket_kind: t.bucket_id ? bucketKindById.get(t.bucket_id) ?? null : null });
    entriesByChild.set(t.child_wallet_id, arr);
  }

  const children: SendChild[] = (childWallets ?? []).map((cw) => {
    const entries = entriesByChild.get(cw.id) ?? [];
    const member = memberById.get(cw.member_id);
    return {
      id: cw.id,
      name: member?.display_name ?? 'Child',
      color: member?.color ?? null,
      spendBalance: balanceFromLedger(entries.filter((e) => e.bucket_kind === 'spend')),
      total: balanceFromLedger(entries),
    };
  });

  return <SendMoneyView wallets={children} canManage={isManager(ctx.active.role)} />;
}
