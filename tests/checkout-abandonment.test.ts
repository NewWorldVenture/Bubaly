import { describe, it, expect } from 'vitest';
import { selectAbandonedSessions, type CheckoutSessionLike } from '@/lib/billing/checkout-abandonment';

const now = new Date('2026-06-22T12:00:00Z').getTime();
const minsAgo = (m: number) => new Date(now - m * 60_000).toISOString();

const s = (over: Partial<CheckoutSessionLike> = {}): CheckoutSessionLike => ({
  session_id: 'cs_1', email: 'a@b.com', name: 'Alex', status: 'pending', created_at: minsAgo(90), ...over,
});

describe('selectAbandonedSessions', () => {
  it('selects pending sessions past the grace window', () => {
    const out = selectAbandonedSessions([s()], now, { graceMinutes: 60, maxAgeHours: 24 });
    expect(out.map((x) => x.session_id)).toEqual(['cs_1']);
  });

  it('skips sessions still inside the grace window', () => {
    const out = selectAbandonedSessions([s({ created_at: minsAgo(30) })], now, { graceMinutes: 60 });
    expect(out).toHaveLength(0);
  });

  it('skips non-pending sessions', () => {
    const out = selectAbandonedSessions(
      [s({ status: 'completed' }), s({ session_id: 'cs_2', status: 'abandoned' })],
      now, { graceMinutes: 60 },
    );
    expect(out).toHaveLength(0);
  });

  it('skips sessions older than the max look-back', () => {
    const out = selectAbandonedSessions([s({ created_at: minsAgo(60 * 48) })], now, { graceMinutes: 60, maxAgeHours: 24 });
    expect(out).toHaveLength(0);
  });

  it('skips sessions with no email to send to', () => {
    const out = selectAbandonedSessions([s({ email: null })], now, { graceMinutes: 60 });
    expect(out).toHaveLength(0);
  });

  it('ignores unparseable timestamps', () => {
    const out = selectAbandonedSessions([s({ created_at: 'not-a-date' })], now, { graceMinutes: 60 });
    expect(out).toHaveLength(0);
  });

  it('defaults to a 60-minute grace / 24-hour window', () => {
    expect(selectAbandonedSessions([s({ created_at: minsAgo(45) })], now)).toHaveLength(0);
    expect(selectAbandonedSessions([s({ created_at: minsAgo(120) })], now)).toHaveLength(1);
  });
});
