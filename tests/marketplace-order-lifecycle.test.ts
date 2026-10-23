import { describe, it, expect } from 'vitest';
import {
  OFFER_TRANSITIONS, ORDER_TRANSITIONS, canOfferTransition, canOrderTransition,
  nextOrderStatuses, isOrderTerminal, isOrderPaid, resolveOfferAcceptance,
  type OfferStatus, type OrderStatus, type OfferLike,
} from '@/lib/marketplace/order-lifecycle';

describe('offer transitions', () => {
  it('open can be accepted/declined/withdrawn; resolved offers are terminal', () => {
    expect(canOfferTransition('open', 'accepted')).toBe(true);
    expect(canOfferTransition('open', 'withdrawn')).toBe(true);
    expect(canOfferTransition('accepted', 'declined')).toBe(false);
    expect(OFFER_TRANSITIONS.declined).toEqual([]);
  });
});

describe('resolveOfferAcceptance', () => {
  const offers: OfferLike[] = [
    { id: 'a', status: 'open' },
    { id: 'b', status: 'open' },
    { id: 'c', status: 'withdrawn' },
  ];

  it('accepts one and auto-declines the other OPEN offers only', () => {
    const changes = resolveOfferAcceptance(offers, 'a');
    expect(changes.get('a')).toBe('accepted');
    expect(changes.get('b')).toBe('declined');
    expect(changes.has('c')).toBe(false); // withdrawn is untouched
  });

  it('throws when the target is missing or not open', () => {
    expect(() => resolveOfferAcceptance(offers, 'z')).toThrow(/not found/i);
    expect(() => resolveOfferAcceptance(offers, 'c')).toThrow(/not open/i);
  });
});

describe('order transitions', () => {
  // In the database's vocabulary (0151); the old table's pending/sold/refunded
  // were statuses marketplace_orders cannot hold.
  it('allows the order flow and blocks illegal jumps', () => {
    expect(canOrderTransition('requested', 'confirmed')).toBe(true);
    expect(canOrderTransition('active', 'returned')).toBe(true);
    expect(canOrderTransition('completed', 'active')).toBe(false);
    expect(canOrderTransition('cancelled', 'completed')).toBe(false);
  });

  it('marks terminal + finished states', () => {
    expect(isOrderTerminal('completed')).toBe(true);
    expect(isOrderTerminal('cancelled')).toBe(true);
    expect(isOrderTerminal('requested')).toBe(false);
    expect(isOrderPaid('completed')).toBe(true);
    expect(isOrderPaid('returned')).toBe(false);
    expect(isOrderPaid('requested')).toBe(false);
  });

  it('has no dangling edges', () => {
    const all = Object.keys(ORDER_TRANSITIONS) as OrderStatus[];
    for (const from of all) for (const to of nextOrderStatuses(from)) expect(all).toContain(to);
  });

  it('offer statuses are exactly the DB-valid set', () => {
    expect((Object.keys(OFFER_TRANSITIONS) as OfferStatus[]).sort()).toEqual(['accepted', 'declined', 'open', 'withdrawn']);
  });
});
