import { describe, it, expect } from 'vitest';
import { reconcileLedger, anomalyLabel, type ReconTxn } from '@/lib/wallet/reconcile';

const NOW = new Date('2026-06-26T12:00:00Z');

function txn(over: Partial<ReconTxn>): ReconTxn {
  return {
    id: 'tx-' + Math.random().toString(36).slice(2),
    child_wallet_id: 'w1',
    bucket_kind: 'spend',
    direction: 'credit',
    amount_cents: 1000,
    status: 'completed',
    type: 'parent_top_up',
    reverses_id: null,
    created_at: '2026-06-25T12:00:00Z',
    ...over,
  };
}

describe('reconcileLedger — healthy ledger', () => {
  it('reports no anomalies for a clean credit/debit set', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', direction: 'credit', amount_cents: 5000, bucket_kind: 'spend' }),
      txn({ id: 'b', direction: 'debit', amount_cents: 1500, bucket_kind: 'spend', type: 'card_spend' }),
    ];
    const r = reconcileLedger(txns, NOW);
    expect(r.anomalies).toHaveLength(0);
    expect(r.healthy).toBe(true);
    expect(r.creditVolumeCents).toBe(5000);
    expect(r.debitVolumeCents).toBe(1500);
    expect(r.netCents).toBe(3500);
    expect(r.walletsChecked).toBe(1);
  });

  it('ignores pending txns in volume but counts them', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', direction: 'credit', amount_cents: 5000 }),
      txn({ id: 'b', direction: 'debit', amount_cents: 9999, status: 'pending', created_at: '2026-06-26T11:00:00Z' }),
    ];
    const r = reconcileLedger(txns, NOW);
    expect(r.debitVolumeCents).toBe(0);
    expect(r.pendingCount).toBe(1);
    expect(r.healthy).toBe(true); // recent pending is fine
  });
});

describe('reconcileLedger — anomaly detection', () => {
  it('flags a negative wallet balance', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', direction: 'credit', amount_cents: 1000 }),
      txn({ id: 'b', direction: 'debit', amount_cents: 1500, type: 'card_spend' }),
    ];
    const r = reconcileLedger(txns, NOW);
    expect(r.anomalies.some((x) => x.kind === 'negative_wallet')).toBe(true);
    expect(r.healthy).toBe(false);
  });

  it('flags a negative bucket even when wallet total is positive', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', direction: 'credit', amount_cents: 5000, bucket_kind: 'save' }),
      txn({ id: 'b', direction: 'debit', amount_cents: 1000, bucket_kind: 'spend', type: 'card_spend' }),
    ];
    const r = reconcileLedger(txns, NOW);
    const neg = r.anomalies.find((x) => x.kind === 'negative_bucket');
    expect(neg).toBeTruthy();
    expect(neg?.detail).toContain('spend');
  });

  it('flags an orphan reversal', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', direction: 'credit', amount_cents: 1000 }),
      txn({ id: 'r', direction: 'debit', amount_cents: 1000, type: 'reversal', reverses_id: 'missing' }),
    ];
    const r = reconcileLedger(txns, NOW);
    expect(r.anomalies.some((x) => x.kind === 'orphan_reversal')).toBe(true);
    expect(r.reversalCount).toBe(1);
  });

  it('flags a reversal amount mismatch', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', direction: 'credit', amount_cents: 1000 }),
      txn({ id: 'r', direction: 'debit', amount_cents: 800, type: 'reversal', reverses_id: 'a' }),
    ];
    const r = reconcileLedger(txns, NOW);
    expect(r.anomalies.some((x) => x.kind === 'reversal_mismatch')).toBe(true);
  });

  it('accepts a correct reversal', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', direction: 'credit', amount_cents: 1000 }),
      txn({ id: 'r', direction: 'debit', amount_cents: 1000, type: 'reversal', reverses_id: 'a' }),
    ];
    const r = reconcileLedger(txns, NOW);
    expect(r.anomalies.filter((x) => x.kind === 'reversal_mismatch' || x.kind === 'orphan_reversal')).toHaveLength(0);
  });

  it('flags a stuck pending older than 48h', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', direction: 'credit', amount_cents: 1000, status: 'pending', created_at: '2026-06-23T12:00:00Z' }),
    ];
    const r = reconcileLedger(txns, NOW);
    expect(r.anomalies.some((x) => x.kind === 'stuck_pending')).toBe(true);
  });

  it('does not flag a recent pending', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', direction: 'credit', amount_cents: 1000, status: 'pending', created_at: '2026-06-26T06:00:00Z' }),
    ];
    const r = reconcileLedger(txns, NOW);
    expect(r.anomalies.some((x) => x.kind === 'stuck_pending')).toBe(false);
  });
});

describe('reconcileLedger — multi-wallet', () => {
  it('isolates anomalies per wallet', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', child_wallet_id: 'w1', direction: 'credit', amount_cents: 2000 }),
      txn({ id: 'b', child_wallet_id: 'w2', direction: 'debit', amount_cents: 500, type: 'card_spend' }),
    ];
    const r = reconcileLedger(txns, NOW);
    expect(r.walletsChecked).toBe(2);
    expect(r.anomalies.some((x) => x.kind === 'negative_wallet' && x.childWalletId === 'w2')).toBe(true);
    expect(r.anomalies.some((x) => x.childWalletId === 'w1')).toBe(false);
  });
});

describe('anomalyLabel', () => {
  it('returns human labels', () => {
    expect(anomalyLabel('negative_wallet')).toBe('Negative wallet balance');
    expect(anomalyLabel('orphan_reversal')).toBe('Orphan reversal');
  });
});

// ── Money that belongs to no bucket ──────────────────────────────────────────
//
// These replace the "bucket sum drift" check, which could not fire: it compared
// Σ(bucket balances) against the wallet total, but both were accumulated from
// the same signed value in the same loop, so they agreed for every possible
// input. The tests below are the ones that could not be written against it.
describe('reconcileLedger — unattributed money', () => {
  it('flags a completed entry whose bucket is unknown', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', direction: 'credit', amount_cents: 5000, bucket_kind: 'spend' }),
      txn({ id: 'b', direction: 'credit', amount_cents: 2500, bucket_kind: null }),
    ];
    const r = reconcileLedger(txns, NOW);
    const found = r.anomalies.filter((a) => a.kind === 'unattributed_bucket');
    expect(found).toHaveLength(1);
    expect(found[0].amountCents).toBe(2500);
    expect(found[0].childWalletId).toBe('w1');
    expect(r.unattributedCents).toBe(2500);
  });

  it('does not hide unbucketed money inside the spend bucket', () => {
    // The whole point: 2500¢ in no bucket must not read as 2500¢ of spend, and
    // must not mask a genuinely negative spend bucket sitting underneath it.
    const txns: ReconTxn[] = [
      txn({ id: 'a', direction: 'debit', amount_cents: 400, bucket_kind: 'spend', type: 'card_spend' }),
      txn({ id: 'b', direction: 'credit', amount_cents: 2500, bucket_kind: null }),
    ];
    const r = reconcileLedger(txns, NOW);
    expect(r.anomalies.some((a) => a.kind === 'negative_bucket')).toBe(true);
    expect(r.anomalies.some((a) => a.kind === 'unattributed_bucket')).toBe(true);
    expect(r.unattributedCents).toBe(2500);
  });

  it('reports it per wallet, not once for the whole ledger', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', child_wallet_id: 'w1', amount_cents: 100, bucket_kind: null }),
      txn({ id: 'b', child_wallet_id: 'w2', amount_cents: 700, bucket_kind: null }),
    ];
    const r = reconcileLedger(txns, NOW);
    const found = r.anomalies.filter((a) => a.kind === 'unattributed_bucket');
    expect(found.map((a) => a.childWalletId).sort()).toEqual(['w1', 'w2']);
    expect(r.unattributedCents).toBe(800);
  });

  it('stays silent for a pending unbucketed row — that is the stuck-pending check', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', amount_cents: 2500, bucket_kind: null, status: 'pending', created_at: NOW.toISOString() }),
    ];
    const r = reconcileLedger(txns, NOW);
    expect(r.anomalies.some((a) => a.kind === 'unattributed_bucket')).toBe(false);
    expect(r.unattributedCents).toBe(0);
  });

  it('is a warning, not a critical — the total is right, the attribution is not', () => {
    const txns: ReconTxn[] = [txn({ id: 'a', amount_cents: 2500, bucket_kind: null })];
    const r = reconcileLedger(txns, NOW);
    expect(r.anomalies.find((a) => a.kind === 'unattributed_bucket')?.severity).toBe('medium');
    expect(r.healthy).toBe(true);
  });

  it('keeps the wallet total whole: Σ(buckets) + unattributed = total', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', direction: 'credit', amount_cents: 5000, bucket_kind: 'save' }),
      txn({ id: 'b', direction: 'debit', amount_cents: 1200, bucket_kind: 'save', type: 'card_spend' }),
      txn({ id: 'c', direction: 'credit', amount_cents: 2500, bucket_kind: null }),
    ];
    const r = reconcileLedger(txns, NOW);
    // No negative anywhere, so the only anomaly is the attribution gap.
    expect(r.anomalies.map((a) => a.kind)).toEqual(['unattributed_bucket']);
    expect(r.creditVolumeCents - r.debitVolumeCents).toBe(6300);
    expect(r.unattributedCents).toBe(2500);
  });

  it('a fully bucketed ledger reports nothing and zero unattributed', () => {
    const txns: ReconTxn[] = [
      txn({ id: 'a', direction: 'credit', amount_cents: 5000, bucket_kind: 'spend' }),
      txn({ id: 'b', direction: 'credit', amount_cents: 900, bucket_kind: 'give' }),
    ];
    const r = reconcileLedger(txns, NOW);
    expect(r.anomalies).toHaveLength(0);
    expect(r.unattributedCents).toBe(0);
  });
});
