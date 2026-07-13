import { describe, it, expect } from 'vitest';
import {
  whoseTurn, isMyTurn, availableActions, validateOfferAmount,
  suggestedOpeningCents, suggestedCounterCents, savingsPercent,
  statusLine, roundLine, orderRounds,
  type Negotiation, type Round,
} from '@/lib/marketplace/negotiation';

const open = (lastActor: 'buyer' | 'seller', amt = 6000): Negotiation => ({
  status: 'open', currentAmountCents: amt, lastActor,
});

describe('turn model', () => {
  it('the other party moves next', () => {
    expect(whoseTurn(open('buyer'))).toBe('seller');
    expect(whoseTurn(open('seller'))).toBe('buyer');
  });
  it('closed threads have no turn', () => {
    expect(whoseTurn({ status: 'agreed', lastActor: 'seller' })).toBeNull();
    expect(whoseTurn({ status: 'declined', lastActor: 'buyer' })).toBeNull();
  });
  it('isMyTurn reflects whoseTurn', () => {
    expect(isMyTurn(open('buyer'), 'seller')).toBe(true);
    expect(isMyTurn(open('buyer'), 'buyer')).toBe(false);
  });
});

describe('availableActions', () => {
  it('on your turn you can accept, counter, and bail', () => {
    // buyer moved last → seller's turn
    expect(availableActions(open('buyer'), 'seller').sort()).toEqual(['accept', 'counter', 'decline'].sort());
    // seller moved last → buyer's turn
    expect(availableActions(open('seller'), 'buyer').sort()).toEqual(['accept', 'counter', 'withdraw'].sort());
  });
  it('off-turn you can only bail (buyer withdraw / seller decline)', () => {
    expect(availableActions(open('buyer'), 'buyer')).toEqual(['withdraw']);
    expect(availableActions(open('seller'), 'seller')).toEqual(['decline']);
  });
  it('closed thread offers no actions', () => {
    expect(availableActions({ status: 'agreed', lastActor: 'buyer' }, 'seller')).toEqual([]);
  });
});

describe('amount validation & suggestions', () => {
  it('rejects non-positive and at/above ask', () => {
    expect(validateOfferAmount(0, 10000)).toBeTruthy();
    expect(validateOfferAmount(-5, 10000)).toBeTruthy();
    expect(validateOfferAmount(10000, 10000)).toBeTruthy();
    expect(validateOfferAmount(10500, 10000)).toBeTruthy();
  });
  it('accepts a below-ask offer', () => {
    expect(validateOfferAmount(6000, 10000)).toBeNull();
  });
  it('opening suggestion is ~85% of ask, tidy dollars', () => {
    expect(suggestedOpeningCents(10000)).toBe(8500);
    expect(suggestedOpeningCents(0)).toBe(0);
  });
  it('counter suggestion meets in the middle', () => {
    expect(suggestedCounterCents(6000, 10000)).toBe(8000);
    expect(suggestedCounterCents(9000, 8000)).toBe(8000); // ask below current → ask
  });
});

describe('savings', () => {
  it('computes whole-percent savings vs ask', () => {
    expect(savingsPercent(7500, 10000)).toBe(25);
    expect(savingsPercent(10000, 10000)).toBe(0);
    expect(savingsPercent(5000, 0)).toBe(0);
  });
});

describe('human lines', () => {
  it('statusLine speaks from the viewer side', () => {
    expect(statusLine(open('buyer'), 'seller')).toContain('Your move');
    expect(statusLine(open('buyer'), 'buyer')).toContain('Waiting on the seller');
    expect(statusLine({ status: 'agreed', currentAmountCents: 7500, lastActor: 'seller', agreedAmountCents: 7500 }, 'buyer'))
      .toContain('Deal agreed at $75.00');
  });
  it('roundLine renders each kind', () => {
    expect(roundLine({ actorRole: 'buyer', kind: 'offer', amountCents: 6000, createdAt: 'a' })).toBe('Buyer offered $60.00');
    expect(roundLine({ actorRole: 'seller', kind: 'counter', amountCents: 8500, createdAt: 'b' })).toBe('Seller countered $85.00');
    expect(roundLine({ actorRole: 'seller', kind: 'accept', amountCents: 7500, createdAt: 'c' })).toBe('Seller accepted $75.00');
    expect(roundLine({ actorRole: 'buyer', kind: 'withdraw', createdAt: 'd' })).toBe('Buyer withdrew');
  });
});

describe('orderRounds', () => {
  it('sorts oldest first without mutating input', () => {
    const rounds: Round[] = [
      { actorRole: 'seller', kind: 'counter', createdAt: '2026-01-02' },
      { actorRole: 'buyer', kind: 'offer', createdAt: '2026-01-01' },
    ];
    const sorted = orderRounds(rounds);
    expect(sorted.map((r) => r.kind)).toEqual(['offer', 'counter']);
    expect(rounds[0].kind).toBe('counter'); // original untouched
  });
});
