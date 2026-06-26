// lib/wallet/reconcile.ts — Ledger integrity / reconciliation. PURE + tested.
//
// A money product must be able to PROVE the ledger is internally consistent.
// This module takes raw transaction rows and reports any anomaly an operator
// should investigate, without ever mutating data. All amounts are integer cents.
//
// Checks performed:
//  1. Negative wallet balance      — a child wallet whose derived total is < 0
//  2. Negative bucket balance      — any single bucket below 0 (overdraft leak)
//  3. Orphan reversal              — a `reversal` row pointing at a missing txn
//  4. Reversal amount mismatch     — a reversal whose cents ≠ the row it reverses
//  5. Stuck pending                — a non-completed txn older than the threshold
//  6. Bucket sum drift             — Σ(bucket balances) ≠ wallet total (rounding leak)

import { signedValue, type Direction, type BucketKind } from '@/lib/wallet/ledger';

export type ReconTxn = {
  id: string;
  child_wallet_id: string | null;
  bucket_kind: BucketKind | null;
  direction: Direction;
  amount_cents: number;
  status: string;
  type: string;
  reverses_id?: string | null;
  created_at: string;
};

export type AnomalyKind =
  | 'negative_wallet'
  | 'negative_bucket'
  | 'orphan_reversal'
  | 'reversal_mismatch'
  | 'stuck_pending'
  | 'bucket_drift';

export type Anomaly = {
  kind: AnomalyKind;
  severity: 'high' | 'medium' | 'low';
  childWalletId: string | null;
  detail: string;
  amountCents?: number;
};

export type ReconReport = {
  totalTxns: number;
  walletsChecked: number;
  creditVolumeCents: number;
  debitVolumeCents: number;
  netCents: number;
  pendingCount: number;
  reversalCount: number;
  anomalies: Anomaly[];
  healthy: boolean;
};

const STUCK_PENDING_MS = 48 * 60 * 60 * 1000; // 48h

/**
 * Reconcile a set of ledger rows. `now` is injectable for deterministic tests.
 */
export function reconcileLedger(txns: ReconTxn[], now: Date = new Date()): ReconReport {
  const anomalies: Anomaly[] = [];
  const byId = new Map<string, ReconTxn>();
  for (const t of txns) byId.set(t.id, t);

  let creditVolumeCents = 0;
  let debitVolumeCents = 0;
  let pendingCount = 0;
  let reversalCount = 0;

  // Per-wallet aggregation
  const walletTotals = new Map<string, number>();
  const walletBuckets = new Map<string, Record<BucketKind, number>>();
  const wallets = new Set<string>();

  for (const t of txns) {
    if (t.child_wallet_id) wallets.add(t.child_wallet_id);

    if (t.status === 'completed') {
      if (t.direction === 'credit') creditVolumeCents += Math.max(0, Math.trunc(t.amount_cents));
      else debitVolumeCents += Math.max(0, Math.trunc(t.amount_cents));
    } else {
      pendingCount += 1;
      // Stuck-pending check
      const age = now.getTime() - new Date(t.created_at).getTime();
      if (age > STUCK_PENDING_MS) {
        anomalies.push({
          kind: 'stuck_pending', severity: 'medium', childWalletId: t.child_wallet_id,
          detail: `Transaction ${t.id} (${t.type}) has been ${t.status} for over 48h`,
          amountCents: t.amount_cents,
        });
      }
    }

    // Reversal integrity
    if (t.type === 'reversal') {
      reversalCount += 1;
      if (t.reverses_id) {
        const orig = byId.get(t.reverses_id);
        if (!orig) {
          anomalies.push({
            kind: 'orphan_reversal', severity: 'high', childWalletId: t.child_wallet_id,
            detail: `Reversal ${t.id} points at missing transaction ${t.reverses_id}`,
            amountCents: t.amount_cents,
          });
        } else if (Math.trunc(orig.amount_cents) !== Math.trunc(t.amount_cents)) {
          anomalies.push({
            kind: 'reversal_mismatch', severity: 'high', childWalletId: t.child_wallet_id,
            detail: `Reversal ${t.id} is ${t.amount_cents}¢ but original ${orig.id} is ${orig.amount_cents}¢`,
            amountCents: t.amount_cents,
          });
        }
      }
    }

    // Aggregate completed entries into wallet + bucket balances
    if (t.child_wallet_id) {
      const v = signedValue({ direction: t.direction, amount_cents: t.amount_cents, status: t.status, bucket_kind: t.bucket_kind });
      walletTotals.set(t.child_wallet_id, (walletTotals.get(t.child_wallet_id) ?? 0) + v);
      const buckets = walletBuckets.get(t.child_wallet_id) ?? { spend: 0, save: 0, give: 0, invest: 0, goal: 0 };
      buckets[t.bucket_kind ?? 'spend'] += v;
      walletBuckets.set(t.child_wallet_id, buckets);
    }
  }

  // Per-wallet anomalies: negative total, negative bucket, sum drift
  for (const walletId of wallets) {
    const total = walletTotals.get(walletId) ?? 0;
    if (total < 0) {
      anomalies.push({
        kind: 'negative_wallet', severity: 'high', childWalletId: walletId,
        detail: `Wallet ${walletId} has a negative balance`, amountCents: total,
      });
    }
    const buckets = walletBuckets.get(walletId) ?? { spend: 0, save: 0, give: 0, invest: 0, goal: 0 };
    let bucketSum = 0;
    for (const k of Object.keys(buckets) as BucketKind[]) {
      bucketSum += buckets[k];
      if (buckets[k] < 0) {
        anomalies.push({
          kind: 'negative_bucket', severity: 'high', childWalletId: walletId,
          detail: `Wallet ${walletId} ${k} bucket is negative`, amountCents: buckets[k],
        });
      }
    }
    if (bucketSum !== total) {
      anomalies.push({
        kind: 'bucket_drift', severity: 'low', childWalletId: walletId,
        detail: `Wallet ${walletId} bucket sum (${bucketSum}¢) ≠ total (${total}¢)`,
        amountCents: bucketSum - total,
      });
    }
  }

  return {
    totalTxns: txns.length,
    walletsChecked: wallets.size,
    creditVolumeCents,
    debitVolumeCents,
    netCents: creditVolumeCents - debitVolumeCents,
    pendingCount,
    reversalCount,
    anomalies,
    healthy: anomalies.filter((a) => a.severity === 'high').length === 0,
  };
}

const ANOMALY_LABELS: Record<AnomalyKind, string> = {
  negative_wallet: 'Negative wallet balance',
  negative_bucket: 'Negative bucket balance',
  orphan_reversal: 'Orphan reversal',
  reversal_mismatch: 'Reversal amount mismatch',
  stuck_pending: 'Stuck pending transaction',
  bucket_drift: 'Bucket sum drift',
};

export function anomalyLabel(kind: AnomalyKind): string {
  return ANOMALY_LABELS[kind] ?? kind;
}
