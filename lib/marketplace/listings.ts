// Marketplace domain logic — pure, framework-free, unit-tested. The React module
// and any server code import these so labels, money math, filtering and the
// offer/claim state machine live in one tested place.
import type { LocaleCode } from '@/lib/i18n/locales';
import { formatCents as formatMoney } from '@/lib/wallet/ledger';

/** A translator, in the shape `useTranslations()` and `getTranslations()` return. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The marketplace's money is in US dollars, and that is a property of the MONEY:
 * none of marketplace_listings, marketplace_bids, marketplace_negotiations or
 * marketplace_orders carries a currency column, so there is nothing to convert
 * and nothing to follow. The READER's locale decides the notation, not the unit.
 */
export const MARKETPLACE_CURRENCY = 'USD';

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

/**
 * Whole cents in the READER's notation — "$12.50" / "$12" in en-US, "12,50 $" /
 * "12 $" in de-DE (cents only when there are some). Negative/NaN clamps to zero.
 *
 * This used to be `$${dollars.toFixed(2)}`: the symbol was text and `toFixed` has
 * no locale, so a German family read "$2768.50" where they write "2.768,50 $".
 * `locale` is REQUIRED rather than defaulted, because a default is exactly how a
 * parameter nobody passes happens — every caller has a reader and must say whose.
 */
export function formatCents(cents: number | null | undefined, locale: LocaleCode): string {
  const n = Number.isFinite(cents) ? Math.max(0, Math.round(cents as number)) : 0;
  return formatMoney(n, MARKETPLACE_CURRENCY, locale);
}

/**
 * An offer's amount as the owner deciding on it reads it, or '' for an offer
 * that names none. Accepting records the order at the offer's amount when it
 * has one (marketplace_accept_offer: `coalesce(offer.amount_cents, price)`), so
 * every place an owner accepts an offer shows it.
 */
export function offerAmountLabel(amountCents: number | null | undefined, locale: LocaleCode): string {
  return amountCents ? formatCents(amountCents, locale) : '';
}

/**
 * The unit a money INPUT shows beside the number, as the reader writes it: the
 * symbol Intl prints for the marketplace currency in `locale`, and whether it
 * goes before the number or after it — "$" before in en-US, "$" after in de-DE
 * ("25 $"), "$US" after in fr-FR. The bid and offer boxes used to hard-code a
 * "$" on the left, so a German bidder typed into "$ [   ]" under a placeholder
 * that read "Max bid (min 2.768,50 $)". Read from the same Intl formatter as
 * every amount around the box, so the two cannot disagree.
 */
export function currencyUnit(locale: LocaleCode): { symbol: string; before: boolean } {
  const parts = new Intl.NumberFormat(locale, { style: 'currency', currency: MARKETPLACE_CURRENCY }).formatToParts(1);
  const unitAt = parts.findIndex((p) => p.type === 'currency');
  const numberAt = parts.findIndex((p) => p.type === 'integer');
  // style: 'currency' always emits a currency part; the code is the honest
  // spelling of the unit if an engine ever did not.
  if (unitAt < 0) return { symbol: MARKETPLACE_CURRENCY, before: false };
  return { symbol: parts[unitAt].value, before: unitAt < numberAt };
}

/** A rent price is a SENTENCE around the amount ("{amount}/day"), not a suffix
 *  glued on in English — German writes "5 $/Tag", and only the catalogue knows. */
const RENT_PRICE_KEY: Record<RentPeriod, string> = {
  hour: 'listings.pricePerHour',
  day: 'listings.pricePerDay',
  week: 'listings.pricePerWeek',
  month: 'listings.pricePerMonth',
};

/** "$12" | "$5/day" | "Free" | "" — the price chip label for a listing, in the
 *  reader's notation and words. */
export function priceLabel(
  kind: ListingKind,
  priceCents: number,
  rentPeriod: RentPeriod | null | undefined,
  locale: LocaleCode,
  t: Translate,
): string {
  if (kind === 'free') return t('listings.free');
  if (!kindHasPrice(kind)) return '';
  const amount = formatCents(priceCents, locale);
  // rent_period is a DB string cast to RentPeriod; an unknown one keeps the bare
  // amount rather than rendering a raw key.
  const rentKey = kind === 'rent' && rentPeriod ? RENT_PRICE_KEY[rentPeriod] : undefined;
  return rentKey ? t(rentKey, { amount }) : amount;
}

/** The character `locale` writes between whole dollars and cents. */
function decimalMark(locale: LocaleCode): string {
  return new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.';
}

/**
 * Parse a user-typed dollar string ("12.50", "$8", "12,50 $") into whole cents,
 * reading it in the notation of `locale`, the language it was typed in.
 *
 * This kept digits and `.` and dropped everything else, so a German "12,50"
 * became 1250 dollars, and the quick-post box listed the item at a hundred times
 * its price. Which mark is the decimal point is now decided like this:
 *   - with both `.` and `,`, the last one ("1.250,75", "1,250.75");
 *   - one mark used more than once separates thousands ("1.234.567");
 *   - one mark used once, followed by anything but three digits, is the decimal
 *     point ("12,5", "12.50"), which is also how the box's own fills read: the
 *     AI draft and the suggestion write `String(cents / 100)` in every locale;
 *   - followed by exactly three digits it is ambiguous ("1.250"), and the
 *     locale decides: a decimal point in en-US, a thousand in de-DE.
 *
 * A `<input type="number">` value is always in the canonical notation, so its
 * callers leave `locale` at the en-US default.
 */
export function dollarsToCents(input: string, locale: LocaleCode = 'en-US'): number {
  const cleaned = input.replace(/[^0-9.,]/g, '');
  if (!/[0-9]/.test(cleaned)) return 0;
  const marks = cleaned.replace(/[0-9]/g, '');
  let decimalAt = -1;
  if (marks.includes('.') && marks.includes(',')) {
    decimalAt = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
  } else if (marks.length === 1) {
    const at = cleaned.search(/[.,]/);
    const ambiguous = cleaned.length - at - 1 === 3;
    if (!ambiguous || cleaned[at] === decimalMark(locale)) decimalAt = at;
  }
  const whole = (decimalAt < 0 ? cleaned : cleaned.slice(0, decimalAt)).replace(/[.,]/g, '');
  const fraction = decimalAt < 0 ? '' : cleaned.slice(decimalAt + 1).replace(/[.,]/g, '');
  const n = Number.parseFloat(`${whole || '0'}.${fraction || '0'}`);
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
