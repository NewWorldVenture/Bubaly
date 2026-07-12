import { describe, it, expect } from 'vitest';
import { decideAuthorization, precheckCardAuthorization } from '@/lib/stripe/webhook';

const base = {
  isFrozen: false, cardStatus: 'active', blockedCategories: [] as string[],
  spendableCents: 5_000, amountCents: 1_200, merchantCategory: 'grocery_stores_supermarkets' as string | null,
};

describe('decideAuthorization (the real-time approve/decline gate)', () => {
  it('approves a normal purchase within balance', () => {
    expect(decideAuthorization(base)).toEqual({ approve: true, reason: 'approved' });
  });

  it('declines when the card is inactive, frozen, or the category is blocked', () => {
    expect(decideAuthorization({ ...base, cardStatus: 'inactive' }).reason).toBe('card_inactive');
    expect(decideAuthorization({ ...base, isFrozen: true }).reason).toBe('card_frozen');
    expect(decideAuthorization({ ...base, blockedCategories: ['grocery_stores_supermarkets'] }).reason)
      .toBe('blocked_category');
  });

  it('declines when the amount exceeds the spendable balance — exact balance passes', () => {
    expect(decideAuthorization({ ...base, amountCents: 5_001 }).reason).toBe('insufficient_spend_balance');
    expect(decideAuthorization({ ...base, amountCents: 5_000 }).approve).toBe(true);
  });

  it('status checks outrank balance (a frozen card never approves, even with funds)', () => {
    const d = decideAuthorization({ ...base, isFrozen: true, spendableCents: 1_000_000 });
    expect(d.approve).toBe(false);
    expect(d.reason).toBe('card_frozen');
  });

  it('ignores category blocks when the merchant category is unknown', () => {
    expect(decideAuthorization({ ...base, merchantCategory: null, blockedCategories: ['bars_taverns'] }).approve)
      .toBe(true);
  });
});

describe('precheckCardAuthorization (card-level gate before the atomic reserve)', () => {
  it('returns null when the card is clean — balance is decided by the reserve', () => {
    expect(precheckCardAuthorization({
      isFrozen: false, cardStatus: 'active', blockedCategories: [], merchantCategory: 'grocery_stores_supermarkets',
    })).toBeNull();
  });

  it('short-circuits with the same reasons as the full decision', () => {
    expect(precheckCardAuthorization({ isFrozen: false, cardStatus: 'canceled', blockedCategories: [], merchantCategory: null })!.reason)
      .toBe('card_inactive');
    expect(precheckCardAuthorization({ isFrozen: true, cardStatus: 'active', blockedCategories: [], merchantCategory: null })!.reason)
      .toBe('card_frozen');
    expect(precheckCardAuthorization({ isFrozen: false, cardStatus: 'active', blockedCategories: ['bars_taverns'], merchantCategory: 'bars_taverns' })!.reason)
      .toBe('blocked_category');
  });
});
