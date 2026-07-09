// Marketplace domain logic — pure, framework-free, unit-tested. The React module
// and any server code import these so labels, money math, filtering and the
// offer/claim state machine live in one tested place.

export type ListingKind = 'sell' | 'rent' | 'borrow' | 'free' | 'wanted' | 'swap' | 'donate';
export type ListingCategory =
  | 'toys' | 'clothing' | 'books' | 'electronics' | 'furniture'
  | 'sports' | 'tools' | 'baby' | 'games' | 'other';
export type ListingCondition = 'new' | 'like_new' | 'good' | 'fair' | 'worn';
export type ListingStatus = 'available' | 'pending' | 'claimed' | 'completed' | 'withdrawn';
export type RentPeriod = 'hour' | 'day' | 'week' | 'month';
export type OfferStatus = 'open' | 'accepted' | 'declined' | 'withdrawn';

export const KIND_LABELS: Record<ListingKind, string> = {
  sell: 'For sale',
  rent: 'For rent',
  borrow: 'To borrow',
  free: 'Free',
  wanted: 'Wanted',
  swap: 'Swap',
  donate: 'Donate',
};

export const CATEGORY_LABELS: Record<ListingCategory, string> = {
  toys: 'Toys', clothing: 'Clothing', books: 'Books', electronics: 'Electronics',
  furniture: 'Furniture', sports: 'Sports', tools: 'Tools', baby: 'Baby',
  games: 'Games', other: 'Other',
};

export const CONDITION_LABELS: Record<ListingCondition, string> = {
  new: 'New', like_new: 'Like new', good: 'Good', fair: 'Fair', worn: 'Worn',
};

export const RENT_PERIOD_LABELS: Record<RentPeriod, string> = {
  hour: '/hr', day: '/day', week: '/wk', month: '/mo',
};

export const KIND_ORDER: ListingKind[] = ['sell', 'rent', 'borrow', 'free', 'wanted', 'swap', 'donate'];

/** Kinds that carry a price/rate. `borrow`/`free`/`wanted`/`swap`/`donate` do not show money. */
export function kindHasPrice(kind: ListingKind): boolean {
  return kind === 'sell' || kind === 'rent';
}

/** Whole cents → "$12.50" (or "$12" when even). Negative/NaN clamps to $0. */
export function formatCents(cents: number | null | undefined): string {
  const n = Number.isFinite(cents) ? Math.max(0, Math.round(cents as number)) : 0;
  const dollars = n / 100;
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** "$12" | "$5/day" | "Free" | "" — the price chip label for a listing. */
export function priceLabel(kind: ListingKind, priceCents: number, rentPeriod?: RentPeriod | null): string {
  if (kind === 'free') return 'Free';
  if (!kindHasPrice(kind)) return '';
  const money = formatCents(priceCents);
  if (kind === 'rent' && rentPeriod) return `${money}${RENT_PERIOD_LABELS[rentPeriod]}`;
  return money;
}

/** Parse a user-typed dollar string ("12.50", "$8") into whole cents. */
export function dollarsToCents(input: string): number {
  const cleaned = input.replace(/[^0-9.]/g, '');
  if (!cleaned) return 0;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
}

export type ListingLike = {
  id: string;
  kind: string;
  category: string;
  status: string;
  price_cents: number;
  title: string;
  member_id: string | null;
  claimed_by: string | null;
  created_at: string;
};

export type ListingFilter = { kind?: ListingKind | 'all'; category?: ListingCategory | 'all'; q?: string };

/** Only listings a browser should see on the board: hide withdrawn + completed. */
export function isBrowsable(status: string): boolean {
  return status === 'available' || status === 'pending' || status === 'claimed';
}

/**
 * Filter + rank listings for the board: browsable first, available before
 * claimed, then newest first. Text query matches the title (case-insensitive).
 */
export function filterListings<T extends ListingLike>(rows: T[], filter: ListingFilter = {}): T[] {
  const { kind = 'all', category = 'all', q = '' } = filter;
  const needle = q.trim().toLowerCase();
  const out = rows.filter((r) => {
    if (!isBrowsable(r.status)) return false;
    if (kind !== 'all' && r.kind !== kind) return false;
    if (category !== 'all' && r.category !== category) return false;
    if (needle && !r.title.toLowerCase().includes(needle)) return false;
    return true;
  });
  const statusRank = (s: string) => (s === 'available' ? 0 : s === 'pending' ? 1 : 2);
  return out.sort((a, b) => {
    const sr = statusRank(a.status) - statusRank(b.status);
    if (sr !== 0) return sr;
    return b.created_at.localeCompare(a.created_at);
  });
}

/** Count of open items on the board, for the header. */
export function availableCount<T extends ListingLike>(rows: T[]): number {
  return rows.filter((r) => r.status === 'available').length;
}

export type OfferLike = { id: string; listing_id: string; member_id: string | null; status: string };

/**
 * Whether `memberId` may place a new offer on a listing: it must be browsable,
 * not their own, and they must not already have an open offer on it.
 */
export function canOffer(
  listing: ListingLike,
  memberId: string | null,
  existingOffers: OfferLike[],
): boolean {
  if (!memberId) return false;
  if (listing.status !== 'available' && listing.status !== 'pending') return false;
  if (listing.member_id === memberId) return false;
  return !existingOffers.some(
    (o) => o.listing_id === listing.id && o.member_id === memberId && o.status === 'open',
  );
}

/** The poster of a listing may accept/decline offers and manage status. */
export function isOwner(listing: ListingLike, memberId: string | null): boolean {
  return !!memberId && listing.member_id === memberId;
}

/** Open offers for a given listing (what the owner reviews). */
export function openOffersFor<T extends OfferLike>(listingId: string, offers: T[]): T[] {
  return offers.filter((o) => o.listing_id === listingId && o.status === 'open');
}
