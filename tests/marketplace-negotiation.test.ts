import { describe, it, expect } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';
import {
  whoseTurn, isMyTurn, availableActions, validateOfferAmount,
  suggestedOpeningCents, suggestedCounterCents, savingsPercent,
  statusLine, roundLine, orderRounds,
  type Negotiation, type Round,
} from '@/lib/marketplace/negotiation';

// The REAL en-US catalogue, so a sentence missing from it fails here instead of
// reaching a family as its key. The negotiation.* sentences are added by the I18N-003
// marketplace change and land in lib/i18n/messages/*.json with the orchestrator's
// catalogue merge: until that merge, the cases that render them are red.
const t = (key: string, params?: Record<string, string | number>) =>
  translate(getMessages('en-US'), key, params);

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
    expect(validateOfferAmount(0, 10000, 'en-US', t)).toBe('Enter an amount above zero.');
    expect(validateOfferAmount(-5, 10000, 'en-US', t)).toBe('Enter an amount above zero.');
    expect(validateOfferAmount(10000, 10000, 'en-US', t)).toBe('That’s at or above the $100.00 asking price — just buy it.');
    expect(validateOfferAmount(10500, 10000, 'en-US', t)).toBeTruthy();
  });
  it('accepts a below-ask offer', () => {
    expect(validateOfferAmount(6000, 10000, 'en-US', t)).toBeNull();
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
    expect(statusLine(open('buyer'), 'seller', 'en-US', t)).toBe('Your move — they’re at $60.00.');
    expect(statusLine(open('buyer'), 'buyer', 'en-US', t)).toBe('Waiting on the seller — you’re at $60.00.');
    expect(statusLine({ status: 'agreed', currentAmountCents: 7500, lastActor: 'seller', agreedAmountCents: 7500 }, 'buyer', 'en-US', t))
      .toBe('Deal agreed at $75.00.');
  });
  it('roundLine renders each kind', () => {
    expect(roundLine({ actorRole: 'buyer', kind: 'offer', amountCents: 6000, createdAt: 'a' }, 'en-US', t)).toBe('Buyer offered $60.00');
    expect(roundLine({ actorRole: 'seller', kind: 'counter', amountCents: 8500, createdAt: 'b' }, 'en-US', t)).toBe('Seller countered $85.00');
    expect(roundLine({ actorRole: 'seller', kind: 'accept', amountCents: 7500, createdAt: 'c' }, 'en-US', t)).toBe('Seller accepted $75.00');
    expect(roundLine({ actorRole: 'buyer', kind: 'withdraw', createdAt: 'd' }, 'en-US', t)).toBe('Buyer withdrew');
    // A round whose nullable amount_cents is null takes the amount-less sentence.
    expect(roundLine({ actorRole: 'buyer', kind: 'offer', amountCents: null, createdAt: 'e' }, 'en-US', t)).toBe('Buyer offered');
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
