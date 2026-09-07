import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { reconcileLedger, type ReconTxn } from '@/lib/wallet/reconcile';
import { ErrorState } from '@/components/ui/states';
import { ReconciliationClient } from './reconciliation-client';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Admin · Wallet Reconciliation', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function ReconciliationPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();

  // Pull buckets to map bucket_id → kind, then the ledger rows.
  const [bucketsResult, txnsResult] = await settleAll([
    supabase.from('wallet_buckets').select('id, kind').limit(20000),
    supabase.from('wallet_transactions')
      .select('id, child_wallet_id, bucket_id, direction, amount_cents, status, type, reverses_id, created_at')
      .order('created_at', { ascending: false })
      .limit(20000),
  ]);

  const readError = bucketsResult.error ?? txnsResult.error;
  if (readError) {
    console.error('[admin-wallet-reconciliation] ledger read failed', readError);
    return (
      <div className="space-y-5">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
            <ShieldCheck className="h-6 w-6 text-brand-text" /> {tr('adminWalletReconciliation.walletReconciliation')}
          </h1>
          <p className="mt-1 text-sm text-muted">{tr('adminWalletReconciliation.readOnlyLedgerIntegrityChecksAcross')}</p>
        </div>
        <ErrorState message={tr('reconciliation.couldNotLoadWalletLedger')} />
        <a href="/admin/wallet/reconciliation" className="text-sm font-medium text-brand-text underline">{tr('adminWalletReconciliation.refreshReconciliation')}</a>
      </div>
    );
  }

  const { data: buckets } = bucketsResult;
  const { data: txns } = txnsResult;

  const bucketKindById = new Map((buckets ?? []).map((b) => [b.id, b.kind]));

  const reconTxns: ReconTxn[] = (txns ?? []).map((t) => ({
    id: t.id,
    child_wallet_id: t.child_wallet_id,
    bucket_kind: t.bucket_id ? (bucketKindById.get(t.bucket_id) as ReconTxn['bucket_kind']) ?? null : null,
    direction: t.direction,
    amount_cents: Number(t.amount_cents),
    status: t.status,
    type: t.type,
    reverses_id: t.reverses_id,
    created_at: t.created_at,
  }));

  const report = reconcileLedger(reconTxns);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
          <ShieldCheck className="h-6 w-6 text-brand-text" /> {tr('adminWalletReconciliation.walletReconciliation')}
        </h1>
        <p className="mt-1 text-sm text-muted">{tr('reconciliation.ledgerIntegrityAcrossEveryFamily')}</p>
      </div>
      <ReconciliationClient report={report} />
    </div>
  );
}
