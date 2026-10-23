import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { reconcileLedger, type ReconTxn } from '@/lib/wallet/reconcile';
import { ErrorState } from '@/components/ui/states';
import { ReconciliationClient } from './reconciliation-client';
import { getTranslations } from '@/lib/i18n/server';
import { readAllAsQuery, readAllByIdAsQuery } from '@/lib/supabase/read-all';

export const metadata: Metadata = { title: 'Admin · Wallet Reconciliation', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function ReconciliationPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();

  // Pull buckets to map bucket_id → kind, then the ledger rows.
  const [bucketsResult, txnsResult] = await settleAll([
    // This page RECONCILES the ledger, so reading part of it is worse than not
    // reading it at all: `.limit(20000)` returned 1,000 rows (PostgREST caps at
    // db-max-rows) and every discrepancy past that went unreported.
    //
    // `failOnMax` closes the second half of the same problem. readAll honoured
    // the 20,000 and then reported `error: null` whether the ledger held 14,000
    // rows or 400,000 — and this read is platform-wide, ordered created_at DESC,
    // so the rows dropped were the OLDEST. A ledger reconciled from its newest
    // 20,000 rows is not incomplete, it is arithmetically wrong, and the page
    // rendered "Everything reconciles" off that prefix. Reaching the ceiling now
    // takes the readError branch below, which is the correct answer at the cap.
    //
    // The ledger pages on the id, not on offsets. Read newest first by offset, a
    // transaction posted between two pages took offset 0 and pushed the last row
    // of one page onto the next, so it was summed twice: a debit counted twice
    // drove a healthy wallet negative and the page reported a critical anomaly
    // that does not exist.
    readAllAsQuery((from, to) => supabase.from('wallet_buckets').select('id, kind').order('id').range(from, to), { max: 20000, failOnMax: true }),
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('wallet_transactions')
        .select('id, child_wallet_id, bucket_id, direction, amount_cents, status, type, reverses_id, created_at');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: 20000, failOnMax: true }),
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

  // Newest first, the order the report has always been built in; the paged read was ordered by id.
  const ledger = [...(txns ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  const reconTxns: ReconTxn[] = ledger.map((t) => ({
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
