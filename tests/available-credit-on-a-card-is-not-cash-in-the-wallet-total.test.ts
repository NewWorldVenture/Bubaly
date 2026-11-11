import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { walletOverview } from '@/lib/wallet/hub';

// LIBRARY-A893138105BD. A credit card's "available" is credit the family has
// not used, money it could borrow, not money it has. walletOverview added every
// card's available_cents to "Total balance", so a card with $5,000 available
// made the family $5,000 richer. The same class of error was already fixed for
// credit ACCOUNTS (their balance is owed and lowers the total), and neither
// rule had a test.

describe('available credit on a card is not cash in the wallet total', () => {
  it('a credit card with $5,000 available adds nothing to the total', () => {
    const o = walletOverview([{ balance: 1200, type: 'checking' }], [{ kind: 'credit', available_cents: 500000 }], []);
    expect(o.totalCents).toBe(120000);
  });

  it.each([['credit'], ['store'], ['gas'], ['other']])('a %s card adds nothing to the total', (kind) => {
    expect(walletOverview([], [{ kind, available_cents: 500000 }], []).totalCents).toBe(0);
  });

  it.each([['debit'], ['prepaid']])('a %s card holds money the family has, and counts', (kind) => {
    expect(walletOverview([], [{ kind, available_cents: 4250 }], []).totalCents).toBe(4250);
  });

  it('a mixed wallet totals the cash and leaves the credit out', () => {
    const o = walletOverview(
      [{ balance: 1000, type: 'checking' }, { balance: 250.5, type: 'savings' }],
      [
        { kind: 'credit', available_cents: 500000 },
        { kind: 'debit', available_cents: 30000 },
        { kind: 'prepaid', available_cents: 2500 },
        { kind: 'store', available_cents: 80000 },
      ],
      [{ unit: 'points', balance: 100, value_cents: 1000 }],
    );
    expect(o.accountsCents).toBe(125050);
    expect(o.totalCents).toBe(125050 + 30000 + 2500 + 1000);
  });

  it('the Cards figure is still what is available across every card, and the count every card', () => {
    const o = walletOverview([], [{ kind: 'credit', available_cents: 500000 }, { kind: 'debit', available_cents: 30000 }], []);
    expect(o.cardsCents).toBe(530000);
    expect(o.cardsCount).toBe(2);
  });

  it('the wallet page hands walletOverview whole card rows, kind included', () => {
    const page = readFileSync('components/wallet/wallet-hub.tsx', 'utf8');
    expect(page).toContain('walletOverview(accounts, cards, rewards)');
    expect(page).toContain("type Card = Tables<'wallet_cards'>;");
  });
});

describe('a credit account is owed, and lowers the wallet total', () => {
  it('a $1,500 card balance lowers the total by $1,500', () => {
    const o = walletOverview([{ balance: 2000, type: 'checking' }, { balance: 1500, type: 'credit' }], [], []);
    expect(o.accountsCents).toBe(50000);
    expect(o.totalCents).toBe(50000);
    expect(o.accountsCount).toBe(2);
  });

  it('a family that owes more than it holds has a negative total', () => {
    expect(walletOverview([{ balance: 100, type: 'savings' }, { balance: 900, type: 'credit' }], [], []).totalCents).toBe(-80000);
  });

  it('a credit account and a credit card together: the debt counts, the unused credit does not', () => {
    const o = walletOverview([{ balance: 1500, type: 'credit' }], [{ kind: 'credit', available_cents: 350000 }], []);
    expect(o.totalCents).toBe(-150000);
  });
});
