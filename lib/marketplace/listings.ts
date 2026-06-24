import type { ListingType, ListingStatus, ItemCondition } from '@/lib/database.types';

export const LISTING_TYPES: { value: ListingType; label: string; emoji: string }[] = [
  { value: 'sell', label: 'For Sale', emoji: '💰' },
  { value: 'trade', label: 'Trade', emoji: '🔄' },
  { value: 'free', label: 'Free', emoji: '🎁' },
  { value: 'wanted', label: 'Wanted', emoji: '🔍' },
];

export const LISTING_STATUSES: { value: ListingStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'sold', label: 'Sold' },
  { value: 'traded', label: 'Traded' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

export const CONDITIONS: { value: ItemCondition; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'like_new', label: 'Like New' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
  { value: 'poor', label: 'Poor' },
];

export const LISTING_CATEGORIES = [
  'Clothing', 'Toys', 'Electronics', 'Furniture', 'Sports',
  'Books', 'Baby', 'Kitchen', 'Outdoor', 'Vehicle', 'Other',
] as const;

export function listingTypeMeta(t: ListingType) {
  return LISTING_TYPES.find((x) => x.value === t) ?? LISTING_TYPES[0];
}

export function conditionLabel(c: ItemCondition): string {
  return CONDITIONS.find((x) => x.value === c)?.label ?? c;
}

export interface ListingLike {
  id: string;
  title: string;
  category: string;
  listing_type: ListingType;
  status: ListingStatus;
  condition: ItemCondition;
  price: number | null;
  created_at: string;
}

export function activeListings(listings: readonly ListingLike[]): ListingLike[] {
  return listings.filter((l) => l.status === 'active');
}

export function listingsByCategory(listings: readonly ListingLike[]): { category: string; count: number }[] {
  const map = new Map<string, number>();
  for (const l of listings) {
    if (l.status !== 'active') continue;
    const cat = l.category || 'Other';
    map.set(cat, (map.get(cat) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

export function listingsByType(listings: readonly ListingLike[]): { type: ListingType; label: string; count: number }[] {
  const map = new Map<ListingType, number>();
  for (const l of listings) {
    if (l.status !== 'active') continue;
    map.set(l.listing_type, (map.get(l.listing_type) ?? 0) + 1);
  }
  return LISTING_TYPES
    .filter((t) => map.has(t.value))
    .map((t) => ({ type: t.value, label: t.label, count: map.get(t.value)! }));
}

export interface MarketplaceSummary {
  total: number;
  active: number;
  text: string;
}

export function marketplaceSummary(listings: readonly ListingLike[]): MarketplaceSummary {
  const active = listings.filter((l) => l.status === 'active').length;
  const sold = listings.filter((l) => l.status === 'sold' || l.status === 'traded').length;
  const parts: string[] = [];
  if (active > 0) parts.push(`${active} active`);
  if (sold > 0) parts.push(`${sold} sold/traded`);
  const text = listings.length === 0
    ? 'No listings yet'
    : parts.length
      ? parts.join(' · ')
      : `${listings.length} listing${listings.length === 1 ? '' : 's'}`;
  return { total: listings.length, active, text };
}

export function fmtPrice(amount: number | null | undefined): string {
  if (amount == null) return 'Free';
  if (amount === 0) return 'Free';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
