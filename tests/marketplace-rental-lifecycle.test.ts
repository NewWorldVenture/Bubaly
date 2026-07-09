import { describe, it, expect } from 'vitest';
import {
  RENTAL_TRANSITIONS, nextStatuses, canTransition, isTerminal,
  canSettleDeposit, settleDeposit, daysLate, lateFeeCents,
  type RentalStatus,
} from '@/lib/marketplace/rental-lifecycle';

describe('state machine', () => {
  it('allows only valid transitions', () => {
    expect(canTransition('requested', 'approved')).toBe(true);
    expect(canTransition('requested', 'completed')).toBe(false);
    expect(canTransition('picked_up', 'returned')).toBe(true);
    expect(canTransition('returned', 'completed')).toBe(true);
  });

  it('marks terminal states', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('declined')).toBe(true);
    expect(isTerminal('active')).toBe(false);
  });

  it('every listed next-status is itself a known status (no dangling edges)', () => {
    const all = Object.keys(RENTAL_TRANSITIONS) as RentalStatus[];
    for (const from of all) {
      for (const to of nextStatuses(from)) expect(all).toContain(to);
    }
  });
});

describe('deposit settlement', () => {
  it('refuses to settle before the return workflow (the hard rule)', () => {
    expect(canSettleDeposit('active')).toBe(false);
    expect(() => settleDeposit('active', 5000, 'as_sent')).toThrow(/return workflow/i);
    expect(() => settleDeposit('picked_up', 5000, 'as_sent')).toThrow();
  });

  it('releases the full deposit for an undamaged return', () => {
    const s = settleDeposit('returned', 5000, 'as_sent');
    expect(s).toEqual({ releaseCents: 5000, forfeitCents: 0, status: 'released' });
    expect(settleDeposit('returned', 5000, 'minor_wear').status).toBe('released');
  });

  it('forfeits up to the assessed damage (capped at the deposit)', () => {
    const partial = settleDeposit('damaged', 5000, 'damaged', 2000);
    expect(partial).toEqual({ releaseCents: 3000, forfeitCents: 2000, status: 'partially_released' });
    const capped = settleDeposit('damaged', 5000, 'damaged', 9999);
    expect(capped).toEqual({ releaseCents: 0, forfeitCents: 5000, status: 'forfeited' });
  });

  it('forfeits the whole deposit for a lost item', () => {
    expect(settleDeposit('completed', 5000, 'lost')).toEqual({ releaseCents: 0, forfeitCents: 5000, status: 'forfeited' });
  });
});

describe('late fees', () => {
  it('counts whole days late and multiplies by the daily fee', () => {
    expect(daysLate('2026-07-01T12:00:00Z', '2026-07-04T12:00:00Z')).toBe(3);
    expect(lateFeeCents('2026-07-01T12:00:00Z', '2026-07-04T12:00:00Z', 500)).toBe(1500);
  });
  it('is zero when on time or dates are missing', () => {
    expect(daysLate('2026-07-05', '2026-07-01')).toBe(0);
    expect(lateFeeCents(null, '2026-07-04', 500)).toBe(0);
  });
});
