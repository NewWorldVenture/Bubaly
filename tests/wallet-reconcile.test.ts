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
