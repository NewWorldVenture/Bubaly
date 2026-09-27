// lib/i18n/grocery-category.ts — a grocery or pantry category in the reader's language.
//
// The stored category is the English word: it is data, existing rows hold it,
// and the shopping list groups by it. What a reader sees is its label. The
// shopping and pantry pages share the vocabulary. Audit C1-S9-116.

const CATEGORY_KEY: Record<string, string> = {
  Produce: 'produce', 'Dairy & Eggs': 'dairyEggs', 'Meat & Seafood': 'meatSeafood', Pantry: 'pantry',
  Beverages: 'beverages', Frozen: 'frozen', Household: 'household', 'Personal Care': 'personalCare',
  Baby: 'baby', Pet: 'pet', Other: 'other',
};

/** A known category in the reader's language; a family's own category as they typed it. */
export function groceryCategoryLabel(tr: (key: string) => string, category: string | null | undefined): string {
  const c = category || 'Other';
  return CATEGORY_KEY[c] ? tr(`groceryCategory.${CATEGORY_KEY[c]}`) : c;
}
