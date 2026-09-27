// lib/marketplace/saved-search.ts — marketplace saved-search / alert matching
// (pure, framework-free, tested).
//
// A member saves a standing search — a keyword plus optional kind / category /
// price ceiling — and the Alerts page matches it against the live board,
// badging what's NEW since they last looked. This is the deterministic core:
// the server feeds real listings + the saved criteria; nothing here does I/O.

import type { LocaleCode } from '@/lib/i18n/locales';
import { formatCents, kindHasPrice, type ListingKind } from '@/lib/marketplace/listings';

/** A translator, in the shape `useTranslations()` and `getTranslations()` return. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

export type SavedSearchCriteria = {
  query?: string | null;         // keyword(s) over title + description
  kind?: string | null;          // exact kind, or null/empty = any
  category?: string | null;      // exact category, or null/empty = any
  maxPriceCents?: number | null;  // ceiling; only constrains priced kinds
};

export type MatchableListing = {
  id: string;
  title: string;
  description?: string | null;
  kind: string;
  category: string;
  price_cents: number;
  status: string;
  created_at: string;
  member_id: string | null;
};

const BROWSABLE = new Set(['available', 'pending']);

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Split a query into lowercased terms (all must appear to match). */
export function searchTerms(query: string | null | undefined): string[] {
  return norm(query).split(/\s+/).filter(Boolean);
}

/**
 * Does one listing satisfy a saved search? A listing must be browsable and — when
 * set — match the kind, category, and price ceiling, and contain EVERY query term
 * across its title + description. An empty criterion never narrows the result.
 * Pass `viewerMemberId` to exclude the member's own listings (you don't alert on
 * your own supply).
 */
export function listingMatchesSearch(
  listing: MatchableListing,
  criteria: SavedSearchCriteria,
  viewerMemberId?: string | null,
): boolean {
  if (!BROWSABLE.has(listing.status)) return false;
  if (viewerMemberId && listing.member_id === viewerMemberId) return false;

  const wantKind = norm(criteria.kind);
  if (wantKind && norm(listing.kind) !== wantKind) return false;

  const wantCat = norm(criteria.category);
  if (wantCat && norm(listing.category) !== wantCat) return false;

  if (typeof criteria.maxPriceCents === 'number' && kindHasPrice(listing.kind as ListingKind)) {
    if (listing.price_cents > criteria.maxPriceCents) return false;
  }

  const terms = searchTerms(criteria.query);
  if (terms.length) {
    const haystack = `${norm(listing.title)} ${norm(listing.description)}`;
    if (!terms.every((t) => haystack.includes(t))) return false;
  }
  return true;
}

/** All matches for a saved search, newest first. */
export function matchesForSearch(
  listings: MatchableListing[],
  criteria: SavedSearchCriteria,
  viewerMemberId?: string | null,
): MatchableListing[] {
  return listings
    .filter((l) => listingMatchesSearch(l, criteria, viewerMemberId))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** How many matches were created strictly after `sinceIso` (the "new" badge). */
export function countNewSince(
  listings: MatchableListing[],
  criteria: SavedSearchCriteria,
  sinceIso: string,
  viewerMemberId?: string | null,
): number {
  return listings.filter(
    (l) => listingMatchesSearch(l, criteria, viewerMemberId) && l.created_at > sinceIso,
  ).length;
}

/**
 * A human summary of a saved search, e.g. "“bike” · For rent · Sports · under $50"
 * — or "… · unter 50 $" for a German reader.
 *
 * The ceiling used to be `under $${Math.round(cents / 100)}`: a literal symbol
 * in an English phrase, so the Alerts page showed a German reader "under $50"
 * beside price chips reading "15 $". `locale` and `t` are the READER's and are
 * required. The ceiling stays in whole dollars, as it always read.
 */
export function describeSearch(
  criteria: SavedSearchCriteria,
  locale: LocaleCode,
  t: Translate,
  kindLabels: Record<string, string> = {},
  categoryLabels: Record<string, string> = {},
): string {
  const parts: string[] = [];
  if (criteria.query?.trim()) parts.push(`“${criteria.query.trim()}”`);
  if (criteria.kind) parts.push(kindLabels[criteria.kind] ?? criteria.kind);
  if (criteria.category) parts.push(categoryLabels[criteria.category] ?? criteria.category);
  if (typeof criteria.maxPriceCents === 'number') {
    const wholeDollars = Math.round(criteria.maxPriceCents / 100) * 100;
    parts.push(t('savedSearch.underAmount', { amount: formatCents(wholeDollars, locale) }));
  }
  return parts.length ? parts.join(' · ') : t('savedSearch.anythingNew');
}
