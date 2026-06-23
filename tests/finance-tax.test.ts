import { describe, expect, it } from 'vitest';
import { taxCategoryLabel, isDeductible, groupByYear, deductibleTotalCents, type TaxDocLike } from '@/lib/finance/tax';

describe('labels / deductible', () => {
  it('labels categories', () => {
    expect(taxCategoryLabel('w2')).toBe('W-2');
    expect(taxCategoryLabel('1099')).toBe('1099');
  });
  it('flags deductible categories', () => {
    expect(isDeductible('charity')).toBe(true);
    expect(isDeductible('deduction')).toBe(true);
    expect(isDeductible('w2')).toBe(false);
  });
});

describe('groupByYear', () => {
  it('groups newest year first', () => {
    const g = groupByYear([{ tax_year: 2024 }, { tax_year: 2025 }, { tax_year: 2024 }]);
    expect(g.map((x) => x.year)).toEqual([2025, 2024]);
    expect(g[1].docs).toHaveLength(2);
  });
});

describe('deductibleTotalCents', () => {
  it('sums only deductible categories', () => {
    const docs: TaxDocLike[] = [
      { tax_year: 2025, category: 'charity', amount_cents: 5000 },
      { tax_year: 2025, category: 'medical', amount_cents: 3000 },
      { tax_year: 2025, category: 'w2', amount_cents: 999999 },
      { tax_year: 2025, category: 'deduction', amount_cents: null },
    ];
    expect(deductibleTotalCents(docs)).toBe(8000);
  });
});
