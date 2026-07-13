import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { reconcileLedger, type ReconTxn } from '@/lib/wallet/reconcile';
import { ReconciliationClient } from './reconciliation-client';

export const metadata: Metadata = { title: 'Admin · Wallet Reconciliation', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function ReconciliationPage() {
  const supabase = createServiceClient();

  // Pull buckets to map bucket_id → kind, then the ledger rows.
  const [{ data: buckets }, { data: txns }] = await Promise.all([
    supabase.from('wallet_buckets').select('id, kind').limit(20000),
    supabase.from('wallet_transactions')
      .select('id, child_wallet_id, bucket_id, direction, amount_cents, status, type, reverses_id, created_at')
      .order('created_at', { ascending: false })
      .limit(20000),
  ]);

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
          <ShieldCheck className="h-6 w-6 text-brand-text" /> Wallet Reconciliation
        </h1>
        <p className="mt-1 text-sm text-muted">
          Ledger integrity across every family. Verifies derived balances, bucket sums, reversal
          correctness, and stuck transactions — read-only, never mutates data.
        </p>
      </div>
      <ReconciliationClient report={report} />
    </div>
  );
}
