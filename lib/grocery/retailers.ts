// lib/grocery/retailers.ts — honest grocery-delivery / pickup hand-off.
//
// We don't hold retailer ordering API keys, so we DON'T pretend to place orders.
// Instead we build real, working deep-links into each retailer's grocery search
// for an item, plus a copy-paste shopping list — a genuine one-tap hand-off the
// user completes in the retailer's own cart. No fabricated "order placed" state.

export interface Retailer {
  id: string;
  name: string;
  emoji: string;
  /** Brand-ish accent for the chip. */
  color: string;
  /** Landing page for the retailer's grocery experience. */
  storeUrl: string;
  /** Build a search URL for a single item name. */
  search: (query: string) => string;
}

const q = (s: string) => encodeURIComponent(s.trim()).replace(/%20/g, '+');

export const RETAILERS: Retailer[] = [
  {
    id: 'instacart', name: 'Instacart', emoji: '🥕', color: '#0AAD0A',
    storeUrl: 'https://www.instacart.com/store',
    search: (s) => `https://www.instacart.com/store/s?k=${q(s)}`,
  },
  {
    id: 'walmart', name: 'Walmart', emoji: '🏪', color: '#0071DC',
    storeUrl: 'https://www.walmart.com/cp/grocery/1115193',
    search: (s) => `https://www.walmart.com/search?q=${q(s)}&typeahead=${q(s)}`,
  },
  {
    id: 'target', name: 'Target', emoji: '🎯', color: '#CC0000',
    storeUrl: 'https://www.target.com/c/grocery/-/N-5xt1a',
    search: (s) => `https://www.target.com/s?searchTerm=${q(s)}`,
  },
  {
    id: 'kroger', name: 'Kroger', emoji: '🏬', color: '#0E4D9E',
    storeUrl: 'https://www.kroger.com/',
    search: (s) => `https://www.kroger.com/search?query=${q(s)}&searchType=default_search`,
  },
  {
    id: 'amazon', name: 'Amazon Fresh', emoji: '📦', color: '#FF9900',
    storeUrl: 'https://www.amazon.com/alm/storefront',
    search: (s) => `https://www.amazon.com/s?k=${q(s)}&i=amazonfresh`,
  },
];

export function retailerById(id: string): Retailer | undefined {
  return RETAILERS.find((r) => r.id === id);
}

/** Deep-link for one item at one retailer (falls back to the store landing page). */
export function itemSearchUrl(retailerId: string, itemName: string): string {
  const r = retailerById(retailerId);
  if (!r) return '#';
  return itemName.trim() ? r.search(itemName) : r.storeUrl;
}

export interface ShoppingLine { name: string; quantity?: string | null }

/** A clean, copy-paste shopping list — what the user pastes into a retailer's
 *  bulk-add box or a note. Checked-off items are excluded by the caller. */
export function buildShoppingText(items: ShoppingLine[]): string {
  return items
    .map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name).trim())
    .filter(Boolean)
    .join('\n');
}
