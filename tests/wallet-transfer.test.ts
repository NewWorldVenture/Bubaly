import { describe, it, expect } from 'vitest';
import { balanceFromLedger, bucketBalances, signedValue, type LedgerEntry } from '@/lib/wallet/ledger';

// These tests pin the ledger invariants the Send-Money + Spend-Request flows
// depend on: a held (requires_parent_approval) row must NOT move a balance, and
// a transfer (debit on sender + credit on recipient) must conserve total money.

describe('held spend requests do not move a balance', () => {
  it('a requires_parent_approval debit counts as 0 until completed', () => {
    const held: LedgerEntry = { direction: 'debit', amount_cents: 2500, status: 'requires_parent_approval' };
    expect(signedValue(held)).toBe(0);

    const ledger: LedgerEntry[] = [
      { direction: 'credit', amount_cents: 5000, status: 'completed', bucket_kind: 'spend' },
      held,
    ];
    // Only the completed credit counts → full 5000 still spendable.
    expect(balanceFromLedger(ledger)).toBe(5000);
    expect(bucketBalances(ledger).spend).toBe(5000);
  });

  it('once approved (completed) the debit reduces the balance', () => {
    const ledger: LedgerEntry[] = [
      { direction: 'credit', amount_cents: 5000, status: 'completed', bucket_kind: 'spend' },
      { direction: 'debit', amount_cents: 2500, status: 'completed', bucket_kind: 'spend' },
    ];
    expect(balanceFromLedger(ledger)).toBe(2500);
    expect(bucketBalances(ledger).spend).toBe(2500);
  });
});

describe('transfers conserve total money across two wallets', () => {
  it('debit on sender + credit on recipient nets to zero family-wide', () => {
    const sender: LedgerEntry[] = [
      { direction: 'credit', amount_cents: 4000, status: 'completed', bucket_kind: 'spend' },
      { direction: 'debit', amount_cents: 1500, status: 'completed', bucket_kind: 'spend' }, // sent
    ];
    const recipient: LedgerEntry[] = [
      { direction: 'credit', amount_cents: 1500, status: 'completed', bucket_kind: 'spend' }, // received
    ];
    expect(balanceFromLedger(sender)).toBe(2500);
    expect(balanceFromLedger(recipient)).toBe(1500);
    // The transfer moved money but created/destroyed none: 4000 total before, 4000 after.
    expect(balanceFromLedger(sender) + balanceFromLedger(recipient)).toBe(4000);
  });

  it('a reversal of a failed transfer restores the sender', () => {
    const sender: LedgerEntry[] = [
      { direction: 'credit', amount_cents: 4000, status: 'completed', bucket_kind: 'spend' },
      { direction: 'debit', amount_cents: 1500, status: 'completed', bucket_kind: 'spend' }, // sent
      { direction: 'credit', amount_cents: 1500, status: 'completed', bucket_kind: 'spend' }, // reversal
    ];
    expect(balanceFromLedger(sender)).toBe(4000);
  });
});
