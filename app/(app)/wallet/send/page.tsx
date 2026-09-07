import type { Metadata } from 'next';
import { AlertTriangle } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { balanceFromLedger, type LedgerEntry, type BucketKind } from '@/lib/wallet/ledger';
import { WalletActivation } from '@/components/wallet/wallet-activation';
import { SendMoneyView, type SendChild } from '@/components/wallet/send-money-view';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Send Money' };
export const dynamic = 'force-dynamic';

export default async function SendMoneyPage() {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const dataWarnings: string[] = [];

  const { data: wallet, error: walletError } = await supabase
    .from('family_wallets').select('id, is_active').eq('family_id', familyId).maybeSingle();
  if (walletError) {
    console.error('[wallet-send] Wallet read failed', walletError);
    return <ErrorState message={tr('send.couldNotLoadTheFamily')} />;
  }
  if (!wallet || !wallet.is_active) return <WalletActivation canActivate={isManager(ctx.active.role)} />;

  const [{ data: childWallets, error: childWalletsError }, { data: buckets, error: bucketsError }, { data: txns, error: txnsError }, { data: members, error: membersError }] = await Promise.all([
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('wallet_buckets').select('id, child_wallet_id, kind').eq('family_id', familyId),
    supabase.from('wallet_transactions')
      .select('child_wallet_id, bucket_id, direction, amount_cents, status')
      .eq('family_id', familyId).limit(3000),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
  ]);
  if (childWalletsError) { console.error('[wallet-send] Child wallets read failed', childWalletsError); dataWarnings.push('Child wallets'); }
  if (bucketsError) { console.error('[wallet-send] Wallet buckets read failed', bucketsError); dataWarnings.push('Wallet buckets'); }
  if (txnsError) { console.error('[wallet-send] Wallet transactions read failed', txnsError); dataWarnings.push('Wallet transactions'); }
  if (membersError) { console.error('[wallet-send] Family members read failed', membersError); dataWarnings.push('Family members'); }

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

  return (
    <div>
      {dataWarnings.length > 0 && (
        <div role="status" aria-label={tr('walletSend.walletSendDataHealth')} className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{tr('walletSend.someWalletDetailsAreTemporarilyUnavailable')} {dataWarnings.join(', ')}.</p>
        </div>
      )}
      <SendMoneyView wallets={children} canManage={isManager(ctx.active.role)} />
    </div>
  );
}
