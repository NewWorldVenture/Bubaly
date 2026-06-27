import { describe, it, expect } from 'vitest';
import {
  rankNeedsAttention, summarizeNeeds, needsHeadline, topNeeds, normalizeUrgency,
  type NeedItem,
} from '@/lib/home/needs-attention';

const mk = (over: Partial<NeedItem>): NeedItem => ({
  id: 'x', kind: 'wallet_approval', title: 't', href: '/h', urgency: 'normal', createdAt: '2026-06-01T00:00:00Z', ...over,
});

describe('normalizeUrgency', () => {
  it('passes known values, defaults others to normal', () => {
    expect(normalizeUrgency('emergency')).toBe('emergency');
    expect(normalizeUrgency('urgent')).toBe('urgent');
    expect(normalizeUrgency('whatever')).toBe('normal');
    expect(normalizeUrgency(null)).toBe('normal');
  });
});

describe('rankNeedsAttention', () => {
  it('orders by urgency then newest, deterministically', () => {
    const items = [
      mk({ id: 'a', urgency: 'normal', createdAt: '2026-06-10T00:00:00Z' }),
      mk({ id: 'b', urgency: 'emergency', createdAt: '2026-06-01T00:00:00Z' }),
      mk({ id: 'c', urgency: 'urgent', createdAt: '2026-06-05T00:00:00Z' }),
      mk({ id: 'd', urgency: 'urgent', createdAt: '2026-06-09T00:00:00Z' }),
    ];
    expect(rankNeedsAttention(items).map((i) => i.id)).toEqual(['b', 'd', 'c', 'a']);
  });
  it('does not mutate the input', () => {
    const items = [mk({ id: 'a', urgency: 'normal' }), mk({ id: 'b', urgency: 'emergency' })];
    const copy = [...items];
    rankNeedsAttention(items);
    expect(items).toEqual(copy);
  });
  it('is stable for equal urgency+time (kind then id)', () => {
    const items = [
      mk({ id: 'z', kind: 'trust_approval', createdAt: '2026-06-01T00:00:00Z' }),
      mk({ id: 'a', kind: 'trust_approval', createdAt: '2026-06-01T00:00:00Z' }),
    ];
    expect(rankNeedsAttention(items).map((i) => i.id)).toEqual(['a', 'z']);
  });
  it('handles empty/nullish', () => {
    expect(rankNeedsAttention([])).toEqual([]);
    // @ts-expect-error nullish tolerance
    expect(rankNeedsAttention(null)).toEqual([]);
  });
});

describe('summarizeNeeds', () => {
  it('counts totals, urgency buckets, and per-kind (respecting count)', () => {
    const s = summarizeNeeds([
      mk({ kind: 'wallet_approval', urgency: 'urgent', count: 2 }),
      mk({ kind: 'renewal', urgency: 'emergency' }),
      mk({ kind: 'wallet_approval', urgency: 'normal' }),
    ]);
    expect(s.total).toBe(4);
    expect(s.urgent).toBe(2);
    expect(s.emergency).toBe(1);
    expect(s.byKind).toEqual({ wallet_approval: 3, renewal: 1 });
  });
});

describe('needsHeadline', () => {
  it('reassures when empty', () => {
    expect(needsHeadline(summarizeNeeds([]))).toMatch(/caught up/i);
  });
  it('singular vs plural', () => {
    expect(needsHeadline(summarizeNeeds([mk({})]))).toBe('1 thing needs you.');
    expect(needsHeadline(summarizeNeeds([mk({ id: '1' }), mk({ id: '2' })]))).toBe('2 things need you.');
  });
  it('flags urgency', () => {
    expect(needsHeadline(summarizeNeeds([mk({ urgency: 'emergency' })]))).toMatch(/urgent/i);
  });
});

describe('topNeeds', () => {
  it('caps shown and reports the remainder', () => {
    const items = Array.from({ length: 8 }, (_, i) => mk({ id: String(i) }));
    const { shown, more } = topNeeds(items, 5);
    expect(shown).toHaveLength(5);
    expect(more).toBe(3);
  });
  it('no remainder when under the cap', () => {
    expect(topNeeds([mk({})], 5).more).toBe(0);
  });
});
