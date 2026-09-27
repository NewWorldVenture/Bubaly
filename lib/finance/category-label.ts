// lib/finance/category-label.ts — a money category in the reader's language.
//
// The stored category is the English word: it is data, existing rows hold it,
// and budgets match transactions by it. What a reader sees is its label. The
// billing and finances pages offer different pick lists ("Dining" and "Dining
// Out"), so both spellings are known here. Audit C1-S9-109, C1-S9-112.

const CATEGORY_KEY: Record<string, string> = {
  Housing: 'housing', Groceries: 'groceries', Dining: 'dining', 'Dining Out': 'diningOut',
  Transport: 'transport', Transportation: 'transportation', Utilities: 'utilities', Kids: 'kids',
  Entertainment: 'entertainment', Health: 'health', Healthcare: 'healthcare', Shopping: 'shopping',
  Subscriptions: 'subscriptions', Insurance: 'insurance', Education: 'education', 'Auto & Gas': 'autoGas',
  'Personal Care': 'personalCare', Gifts: 'gifts', Income: 'income', Transfer: 'transfer', Other: 'other',
};

/** A known category in the reader's language; a family's own category as they typed it. */
export function categoryLabel(tr: (key: string) => string, category: string | null | undefined): string {
  const c = category || 'Other';
  return CATEGORY_KEY[c] ? tr(`financeCategory.${CATEGORY_KEY[c]}`) : c;
}
