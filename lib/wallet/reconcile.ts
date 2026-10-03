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
//  6. Unattributed money           — a completed entry that belongs to no bucket
//  7. Duplicate reversal           — one original undone by two counted reversals
//  8. Reversal wallet mismatch     — a reversal booked to another child wallet
//  9. Reversal direction mismatch  — a reversal pointing the same way as its original
// 10. Reversal of uncounted        — a counted reversal of an original that never counted
// 11. Unanchored reversal          — a reversal that names no original at all
// 12. Reversal cycle               — reversals whose chain of originals loops back
//
// Check 6 replaces a "bucket sum drift" check that compared Σ(bucket balances)
// against the wallet total. Both sides were accumulated from the same `v` in the
// same loop — every entry added `v` to exactly one bucket AND to the total — so
// the two could never disagree and the check could not fire for any input. It
// reported a clean ledger by construction rather than by reconciliation.
//
// What it was reaching for is real, and this is it: an entry whose bucket is
// unknown. `wallet_transactions.bucket_id` is ON DELETE SET NULL and the
// allocation writer stores `bucketByKind.get(k) ?? null`, so completed money can
// legitimately end up attached to no bucket. Folding it into `spend` — as the
// display path in lib/wallet/ledger.ts deliberately does — is wrong HERE: this
// module exists to surface what does not reconcile, and hiding the gap inside a
// real bucket also corrupts that bucket's figure. So it is counted apart, and
// the wallet total still includes it: total = Σ(buckets) + unattributed.

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
  | 'unattributed_bucket'
  | 'duplicate_reversal'
  | 'reversal_wallet_mismatch'
  | 'reversal_direction_mismatch'
  | 'reversal_of_uncounted'
  | 'unanchored_reversal'
  | 'reversal_cycle';

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
  /** Completed cents that belong to no bucket. Counted in the wallet total, in no bucket. */
  unattributedCents: number;
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
  let unattributedCents = 0;

  // Per-wallet aggregation
  const walletTotals = new Map<string, number>();
  const walletBuckets = new Map<string, Record<BucketKind, number>>();
  const walletUnattributed = new Map<string, number>();
  const wallets = new Set<string>();
  // Completed reversals per original, in ledger order, for the duplicate check.
  const countedReversals = new Map<string, ReconTxn[]>();

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

    // Reversal integrity. A reversal undoes its original only when it is the one
    // counted reversal of a counted original, in the same wallet, pointing the
    // other way, for the same cents. Each way it can miss is reported on its
    // own: one row can be wrong in several of them at once.
    if (t.type === 'reversal') {
      reversalCount += 1;
      if (!t.reverses_id) {
        // Medium, like unattributed money: `reverses_id` is ON DELETE SET NULL,
        // so this is also a reversal whose original row was deleted. The figure
        // may be right; nothing left in the ledger can show that it is.
        anomalies.push({
          kind: 'unanchored_reversal', severity: 'medium', childWalletId: t.child_wallet_id,
          detail: `Reversal ${t.id} names no original transaction, so what it undoes cannot be checked`,
          amountCents: t.amount_cents,
        });
      } else {
        const orig = byId.get(t.reverses_id);
        if (!orig) {
          anomalies.push({
            kind: 'orphan_reversal', severity: 'high', childWalletId: t.child_wallet_id,
            detail: `Reversal ${t.id} points at missing transaction ${t.reverses_id}`,
            amountCents: t.amount_cents,
          });
        } else {
          if (Math.trunc(orig.amount_cents) !== Math.trunc(t.amount_cents)) {
            anomalies.push({
              kind: 'reversal_mismatch', severity: 'high', childWalletId: t.child_wallet_id,
              detail: `Reversal ${t.id} is ${t.amount_cents}¢ but original ${orig.id} is ${orig.amount_cents}¢`,
              amountCents: t.amount_cents,
            });
          }
          if (orig.direction === t.direction) {
            anomalies.push({
              kind: 'reversal_direction_mismatch', severity: 'high', childWalletId: t.child_wallet_id,
              detail: `Reversal ${t.id} is a ${t.direction}, the same as original ${orig.id}, so it repeats it instead of undoing it`,
              amountCents: t.amount_cents,
            });
          }
          if (orig.child_wallet_id !== t.child_wallet_id) {
            anomalies.push({
              kind: 'reversal_wallet_mismatch', severity: 'high', childWalletId: t.child_wallet_id,
              detail: `Reversal ${t.id} is booked to wallet ${t.child_wallet_id ?? '(none)'} `
                + `but original ${orig.id} is in wallet ${orig.child_wallet_id ?? '(none)'}`,
              amountCents: t.amount_cents,
            });
          }
          if (t.status === 'completed') {
            if (orig.status !== 'completed') {
              anomalies.push({
                kind: 'reversal_of_uncounted', severity: 'high', childWalletId: t.child_wallet_id,
                detail: `Reversal ${t.id} is completed but original ${orig.id} is ${orig.status}, `
                  + `so it takes back money the original never added`,
                amountCents: t.amount_cents,
              });
            }
            const counted = countedReversals.get(orig.id) ?? [];
            counted.push(t);
            countedReversals.set(orig.id, counted);
          }
        }
      }
    }

    // Aggregate completed entries into wallet + bucket balances
    if (t.child_wallet_id) {
      const v = signedValue({ direction: t.direction, amount_cents: t.amount_cents, status: t.status, bucket_kind: t.bucket_kind });
      walletTotals.set(t.child_wallet_id, (walletTotals.get(t.child_wallet_id) ?? 0) + v);
      if (t.bucket_kind) {
        const buckets = walletBuckets.get(t.child_wallet_id) ?? { spend: 0, save: 0, give: 0, invest: 0, goal: 0 };
        buckets[t.bucket_kind] += v;
        walletBuckets.set(t.child_wallet_id, buckets);
      } else if (v !== 0) {
        // Completed, non-zero, and attached to no bucket. A pending row scores 0
        // through signedValue and is the stuck-pending check's business, not this one.
        walletUnattributed.set(t.child_wallet_id, (walletUnattributed.get(t.child_wallet_id) ?? 0) + v);
        unattributedCents += v;
      }
    }
  }

  // An original can be undone once. Every counted reversal past the first takes
  // its cents out again; reported once per original, for the cents beyond one.
  for (const [origId, counted] of countedReversals) {
    if (counted.length < 2) continue;
    const orig = byId.get(origId)!;
    anomalies.push({
      kind: 'duplicate_reversal', severity: 'high', childWalletId: orig.child_wallet_id,
      detail: `Transaction ${orig.id} is reversed ${counted.length} times (${counted.map((r) => r.id).join(', ')}); `
        + `it can only be undone once`,
      amountCents: (counted.length - 1) * Math.max(0, Math.trunc(orig.amount_cents)),
    });
  }

  // A chain of reversals has to end at a transaction that is not a reversal.
  // Two reversals naming each other each pass every check above — opposite
  // directions, equal cents, a completed "original", one reversal apiece — yet
  // neither undoes anything that happened. Walk `reverses_id` from every
  // reversal; a walk that comes back on itself is a loop, reported once with
  // its members and any reversal whose chain runs into it. A walk that stops at
  // a missing or unnamed original is the orphan/unanchored checks' business.
  const loopOf = new Map<string, string | null>(); // reversal id → loop key, or null when the chain ends
  const loops = new Map<string, { members: string[]; feeders: string[] }>();
  for (const start of txns) {
    if (start.type !== 'reversal' || loopOf.has(start.id)) continue;
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let cur: ReconTxn | undefined = start;
    let key: string | null = null;
    while (cur && cur.type === 'reversal') {
      if (loopOf.has(cur.id)) { key = loopOf.get(cur.id) ?? null; break; }
      const seen = onPath.get(cur.id);
      if (seen !== undefined) {
        const members = path.slice(seen);
        key = members[0];
        loops.set(key, { members, feeders: [] });
        break;
      }
      onPath.set(cur.id, path.length);
      path.push(cur.id);
      cur = cur.reverses_id ? byId.get(cur.reverses_id) : undefined;
    }
    for (const id of path) {
      loopOf.set(id, key);
      if (key && !loops.get(key)!.members.includes(id)) loops.get(key)!.feeders.push(id);
    }
  }
  for (const { members, feeders } of loops.values()) {
    const rows = [...members, ...feeders].map((id) => byId.get(id)!);
    const first = byId.get(members[0])!;
    anomalies.push({
      kind: 'reversal_cycle', severity: 'high', childWalletId: first.child_wallet_id,
      detail: `Reversals ${members.join(' → ')} reverse each other in a loop, so none of them undoes a real transaction`
        + (feeders.length ? `; ${feeders.join(', ')} ${feeders.length === 1 ? 'reverses' : 'reverse'} into it` : ''),
      amountCents: rows.reduce((sum, t) => sum + (t.status === 'completed'
        ? (t.direction === 'credit' ? 1 : -1) * Math.max(0, Math.trunc(t.amount_cents)) : 0), 0),
    });
  }

  // Per-wallet anomalies: negative total, negative bucket, unattributed money
  for (const walletId of wallets) {
    const total = walletTotals.get(walletId) ?? 0;
    if (total < 0) {
      anomalies.push({
        kind: 'negative_wallet', severity: 'high', childWalletId: walletId,
        detail: `Wallet ${walletId} has a negative balance`, amountCents: total,
      });
    }
    const buckets = walletBuckets.get(walletId) ?? { spend: 0, save: 0, give: 0, invest: 0, goal: 0 };
    for (const k of Object.keys(buckets) as BucketKind[]) {
      if (buckets[k] < 0) {
        anomalies.push({
          kind: 'negative_bucket', severity: 'high', childWalletId: walletId,
          detail: `Wallet ${walletId} ${k} bucket is negative`, amountCents: buckets[k],
        });
      }
    }
    // Medium, not high: the money is present and the wallet total is right — it
    // is the attribution that is missing. Only a figure that is actually wrong
    // (a negative balance, a broken reversal) should turn the ledger unhealthy.
    const unattributed = walletUnattributed.get(walletId) ?? 0;
    if (unattributed !== 0) {
      anomalies.push({
        kind: 'unattributed_bucket', severity: 'medium', childWalletId: walletId,
        detail: `Wallet ${walletId} has ${unattributed}¢ completed in no bucket `
          + `(total ${total}¢); its bucket_id is null or names a bucket that no longer exists`,
        amountCents: unattributed,
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
    unattributedCents,
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
  unattributed_bucket: 'Money in no bucket',
  duplicate_reversal: 'Transaction reversed more than once',
  reversal_wallet_mismatch: 'Reversal in a different wallet',
  reversal_direction_mismatch: 'Reversal in the same direction',
  reversal_of_uncounted: 'Reversal of an uncounted transaction',
  unanchored_reversal: 'Reversal with no original',
  reversal_cycle: 'Reversals that reverse each other',
};

export function anomalyLabel(kind: AnomalyKind): string {
  return ANOMALY_LABELS[kind] ?? kind;
}
