import { describe, it, expect } from 'vitest';
import {
  dollarsToCents, walletOverview, fmtUsd, fmtDollars, fmtCount,
  txnSignedCents, fmtSignedUsd, fmtTxnDate,
} from '@/lib/wallet/hub';

describe('dollarsToCents', () => {
  it('converts and rounds', () => {
    expect(dollarsToCents(87.65)).toBe(8765);
    expect(dollarsToCents(0)).toBe(0);
    expect(dollarsToCents(NaN)).toBe(0);
  });
});

describe('walletOverview', () => {
  it('totals accounts + cards + rewards value and counts', () => {
    const o = walletOverview(
      [{ balance: 2735.40 }, { balance: 2585.35 }, { balance: 150 }],
      [{ available_cents: 125000 }, { available_cents: 120000 }],
      [{ unit: 'points', balance: 1250, value_cents: 12500 }, { unit: 'miles', balance: 1600, value_cents: 20000 }],
    );
    expect(o.accountsCents).toBe(547075);
    expect(o.accountsCount).toBe(3);
    expect(o.cardsCents).toBe(245000);
    expect(o.cardsCount).toBe(2);
    expect(o.rewardsValueCents).toBe(32500);
    expect(o.rewardsPoints).toBe(1250); // only points-unit rewards
    expect(o.totalCents).toBe(547075 + 245000 + 32500);
  });
  it('handles empty inputs', () => {
    const o = walletOverview([], [], []);
    expect(o.totalCents).toBe(0);
    expect(o.accountsCount).toBe(0);
  });
});

describe('formatting', () => {
  it('fmtUsd / fmtDollars show cents', () => {
    expect(fmtUsd(824550)).toBe('$8,245.50');
    expect(fmtDollars(5320.75)).toBe('$5,320.75');
  });
  it('fmtCount groups', () => {
    expect(fmtCount(2850)).toBe('2,850');
  });
  it('fmtTxnDate formats date-only + timestamps', () => {
    expect(fmtTxnDate('2025-05-21')).toBe('May 21, 2025');
  });
});

describe('transaction sign', () => {
  it('income positive, expense/transfer negative', () => {
    expect(txnSignedCents({ amount: 25, type: 'income', status: 'posted' })).toBe(2500);
    expect(txnSignedCents({ amount: 87.65, type: 'expense', status: 'pending' })).toBe(-8765);
    expect(txnSignedCents({ amount: 200, type: 'transfer', status: 'posted' })).toBe(-20000);
  });
  it('fmtSignedUsd prefixes sign', () => {
    expect(fmtSignedUsd(2500)).toBe('+$25.00');
    expect(fmtSignedUsd(-8765)).toBe('-$87.65');
  });
});
