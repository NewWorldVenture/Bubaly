// lib/finance/tax.ts — pure helpers for the Tax Document Vault.
// Category metadata, grouping by year, and deduction totals. No Supabase/React.

export const TAX_CATEGORIES = [
  'w2', '1099', 'receipt', 'deduction', 'statement', 'return', 'property', 'charity', 'medical', 'other',
] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

const LABELS: Record<string, string> = {
  w2: 'W-2', '1099': '1099', receipt: 'Receipt', deduction: 'Deduction', statement: 'Statement',
  return: 'Return', property: 'Property', charity: 'Charity', medical: 'Medical', other: 'Other',
};

/** Categories that contribute to the deductible total. */
const DEDUCTIBLE = new Set(['deduction', 'charity', 'medical', 'property']);

export function taxCategoryLabel(cat: string): string {
  return LABELS[cat] ?? cat;
}
export function isDeductible(cat: string): boolean {
  return DEDUCTIBLE.has(cat);
}

export type TaxDocLike = { tax_year: number; category: string; amount_cents: number | null };

/** Documents grouped by year, newest year first. */
export function groupByYear<T extends { tax_year: number }>(docs: T[]): Array<{ year: number; docs: T[] }> {
  const map = new Map<number, T[]>();
  for (const d of docs) { const a = map.get(d.tax_year) ?? []; a.push(d); map.set(d.tax_year, a); }
  return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([year, docs]) => ({ year, docs }));
}

/** Sum of deductible-category amounts for a set of docs (cents). */
export function deductibleTotalCents(docs: TaxDocLike[]): number {
  return docs.reduce((sum, d) => (isDeductible(d.category) ? sum + (d.amount_cents ?? 0) : sum), 0);
}
