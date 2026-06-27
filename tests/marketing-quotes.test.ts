import { describe, it, expect } from 'vitest';
import {
  isQuoteStatus, isExpired, effectiveStatus, summarizeQuotes, QUOTE_STATUSES,
  type QuoteLike,
} from '@/lib/marketing/quotes';

const now = new Date('2026-06-22T12:00:00Z');
const q = (over: Partial<QuoteLike> = {}): QuoteLike => ({ status: 'sent', amount_cents: 10_000, valid_until: null, ...over });

describe('isQuoteStatus', () => {
  it('validates statuses', () => {
    expect(isQuoteStatus('accepted')).toBe(true);
    expect(isQuoteStatus('nope')).toBe(false);
  });
  it('exposes all statuses', () => {
    expect(QUOTE_STATUSES).toContain('declined');
  });
});

describe('isExpired', () => {
  it('flags open quotes past valid_until', () => {
    expect(isExpired(q({ status: 'sent', valid_until: '2026-06-20' }), now)).toBe(true);
    expect(isExpired(q({ status: 'draft', valid_until: '2026-06-25' }), now)).toBe(false);
  });
  it('never expires accepted/declined quotes', () => {
    expect(isExpired(q({ status: 'accepted', valid_until: '2020-01-01' }), now)).toBe(false);
  });
  it('no valid_until → not expired', () => {
    expect(isExpired(q({ valid_until: null }), now)).toBe(false);
  });
});

describe('effectiveStatus', () => {
  it('reads an overdue open quote as expired', () => {
    expect(effectiveStatus(q({ status: 'sent', valid_until: '2026-06-01' }), now)).toBe('expired');
    expect(effectiveStatus(q({ status: 'sent', valid_until: '2026-12-01' }), now)).toBe('sent');
  });
});

describe('summarizeQuotes', () => {
  it('aggregates outstanding, accepted, and accept rate', () => {
    const s = summarizeQuotes([
      q({ status: 'sent', amount_cents: 10_000, valid_until: '2026-12-01' }),
      q({ status: 'accepted', amount_cents: 50_000 }),
      q({ status: 'accepted', amount_cents: 20_000 }),
      q({ status: 'declined', amount_cents: 30_000 }),
      q({ status: 'sent', amount_cents: 99_000, valid_until: '2026-01-01' }), // expired → not outstanding
    ], now);
    expect(s.total).toBe(5);
    expect(s.outstandingCents).toBe(10_000);
    expect(s.acceptedCents).toBe(70_000);
    expect(s.acceptRate).toBeCloseTo(2 / 3);
  });
  it('accept rate 0 when nothing decided', () => {
    expect(summarizeQuotes([q({ status: 'draft', valid_until: null })], now).acceptRate).toBe(0);
  });
});
