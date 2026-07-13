import { describe, it, expect } from 'vitest';
import {
  attentionItems, attentionScore, needsAttention, rankListings, sellerTotals,
  type ListingSignals,
} from '@/lib/marketplace/selling';

const base: ListingSignals = {
  id: 'x', title: 'Item', status: 'available', saleFormat: 'fixed',
  watchers: 0, openOffers: 0, openNegotiations: 0, myTurnNegotiations: 0,
  unansweredQuestions: 0, auctionBids: 0, auctionEndingSoon: false,
  pendingHandoffs: 0, overdueReturns: 0,
};
const sig = (o: Partial<ListingSignals>): ListingSignals => ({ ...base, ...o });

describe('attentionItems', () => {
  it('lists urgent signals first with tones', () => {
    const items = attentionItems(sig({ overdueReturns: 1, unansweredQuestions: 2, watchers: 5 }));
    expect(items[0]).toEqual({ label: '1 overdue return', tone: 'danger', urgent: true });
    expect(items[1]).toEqual({ label: '2 questions to answer', tone: 'warn', urgent: true });
    expect(items.at(-1)).toEqual({ label: '5 watchers', tone: 'muted', urgent: false });
  });
  it('pluralizes correctly', () => {
    expect(attentionItems(sig({ watchers: 1 }))[0].label).toBe('1 watcher');
    expect(attentionItems(sig({ myTurnNegotiations: 1 }))[0].label).toBe('1 offer need your reply');
  });
  it('separates my-turn offers from other open offers', () => {
    // 3 open negotiations, 1 of which is my turn → "1 need reply" + "2 open offers"
    const items = attentionItems(sig({ openNegotiations: 3, myTurnNegotiations: 1 }));
    expect(items.some((i) => i.label === '1 offer need your reply')).toBe(true);
    expect(items.some((i) => i.label === '2 open offers')).toBe(true);
  });
  it('empty when nothing is happening', () => {
    expect(attentionItems(base)).toEqual([]);
  });
});

describe('attentionScore / needsAttention', () => {
  it('urgent signals dominate interest', () => {
    expect(attentionScore(sig({ overdueReturns: 1 }))).toBeGreaterThan(attentionScore(sig({ watchers: 100 })));
    expect(attentionScore(sig({ unansweredQuestions: 1 }))).toBeGreaterThan(attentionScore(sig({ auctionBids: 20 })));
  });
  it('flags anything with an urgent item', () => {
    expect(needsAttention(sig({ unansweredQuestions: 1 }))).toBe(true);
    expect(needsAttention(sig({ watchers: 9, auctionBids: 4 }))).toBe(false);
  });
});

describe('rankListings', () => {
  it('orders by attention then title', () => {
    const list = [
      sig({ id: 'a', title: 'Zebra', watchers: 2 }),
      sig({ id: 'b', title: 'Apple', overdueReturns: 1 }),
      sig({ id: 'c', title: 'Mango', unansweredQuestions: 1 }),
    ];
    expect(rankListings(list).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });
  it('is stable on equal scores (title order) and does not mutate', () => {
    const list = [sig({ id: 'z', title: 'Zed' }), sig({ id: 'a', title: 'Ace' })];
    expect(rankListings(list).map((s) => s.id)).toEqual(['a', 'z']);
    expect(list[0].id).toBe('z');
  });
});

describe('sellerTotals', () => {
  it('rolls up the tiles', () => {
    const list = [
      sig({ status: 'available', watchers: 3, openOffers: 1, unansweredQuestions: 2 }),
      sig({ status: 'claimed', watchers: 1, openNegotiations: 1 }),
      sig({ status: 'pending', overdueReturns: 1 }),
    ];
    expect(sellerTotals(list)).toEqual({
      activeListings: 2,       // available + pending
      watchers: 4,
      openOffers: 2,           // 1 offer + 1 negotiation
      questionsToAnswer: 2,
      needsAttention: 2,       // the questions one + the overdue one
    });
  });
});
