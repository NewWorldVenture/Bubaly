import { describe, it, expect } from 'vitest';
import {
  factMatches, filterFacts, groupByCategory, factCount, FACT_CATEGORY_ORDER,
  type FactLike,
} from '@/lib/memory/facts';

const mk = (over: Partial<FactLike> & { id: string }): FactLike => ({
  member_id: 'm1', category: 'other', label: 'Label', value: 'Value', notes: null,
  is_pinned: false, updated_at: '2026-07-01T00:00:00Z', ...over,
});

describe('factMatches', () => {
  it('matches label, value, or notes case-insensitively', () => {
    const f = mk({ id: 'a', label: 'Shoe size', value: 'US 2', notes: 'runs small' });
    expect(factMatches(f, 'shoe')).toBe(true);
    expect(factMatches(f, 'us 2')).toBe(true);
    expect(factMatches(f, 'SMALL')).toBe(true);
    expect(factMatches(f, 'peanut')).toBe(false);
    expect(factMatches(f, '')).toBe(true);
  });
});

describe('filterFacts', () => {
  const rows: FactLike[] = [
    mk({ id: 'a', member_id: 'm1', category: 'sizes', label: 'Shoe', is_pinned: false, updated_at: '2026-07-01' }),
    mk({ id: 'b', member_id: null, category: 'contact', label: 'Doctor', is_pinned: true, updated_at: '2026-06-01' }),
    mk({ id: 'c', member_id: 'm2', category: 'medical', label: 'Allergy', value: 'Peanuts', updated_at: '2026-07-03' }),
    mk({ id: 'd', member_id: 'm1', category: 'sizes', label: 'Shirt', is_pinned: false, updated_at: '2026-07-05' }),
  ];
  it('sorts pinned first, then newest updated', () => {
    expect(filterFacts(rows).map((f) => f.id)).toEqual(['b', 'd', 'c', 'a']);
  });
  it('filters by member', () => {
    expect(filterFacts(rows, { member: 'm1' }).map((f) => f.id).sort()).toEqual(['a', 'd']);
  });
  it("member='family' shows only family-level facts", () => {
    expect(filterFacts(rows, { member: 'family' }).map((f) => f.id)).toEqual(['b']);
  });
  it('filters by category and query', () => {
    expect(filterFacts(rows, { category: 'sizes' }).map((f) => f.id)).toEqual(['d', 'a']);
    expect(filterFacts(rows, { q: 'peanut' }).map((f) => f.id)).toEqual(['c']);
  });
});

describe('groupByCategory', () => {
  it('groups in canonical order and coerces unknown categories to other', () => {
    const rows: FactLike[] = [
      mk({ id: 'a', category: 'sizes', updated_at: '2026-07-01' }),
      mk({ id: 'b', category: 'medical', updated_at: '2026-07-02' }),
      mk({ id: 'c', category: 'zzz-unknown', updated_at: '2026-07-03' }),
    ];
    const grouped = groupByCategory(rows);
    const cats = grouped.map(([c]) => c);
    // medical precedes sizes precedes other, per FACT_CATEGORY_ORDER
    expect(cats).toEqual(['medical', 'sizes', 'other']);
    expect(grouped.find(([c]) => c === 'other')![1][0].id).toBe('c');
  });
  it('FACT_CATEGORY_ORDER covers all nine categories', () => {
    expect(new Set(FACT_CATEGORY_ORDER).size).toBe(9);
  });
});

describe('factCount', () => {
  it('counts rows', () => {
    expect(factCount([mk({ id: 'a' }), mk({ id: 'b' })])).toBe(2);
  });
});
