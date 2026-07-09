// lib/marketplace/server.ts — where the marketplace's pure engines meet Supabase.
// Server-only loaders that read real rows (reviews, verifications) and run them
// through the tested engines (reviews, trust) to produce the values the UI shows:
// a member's rating summary + trust score/badges. Degrades to safe empties on any
// read error so a profile still renders.

import type { SupabaseClient } from '@supabase/supabase-js';
import { aggregateReviews, toTrustRatingSignals, type ReviewInput, type ReviewSummary } from './reviews';
import { computeTrustScore, type TrustResult, type TrustSignals, type VerificationKind } from './trust';
import { computeFees, type CommissionPolicy, type FeeBreakdown, type PromoOverride } from './fees';
import type { Database } from '@/lib/database.types';

type OrderInsert = Database['public']['Tables']['marketplace_orders']['Insert'];

// Accept any Supabase client (server or service-role); the caller owns auth/RLS.
type DB = Pick<SupabaseClient, 'from'>;

const VERIFICATION_KINDS: readonly VerificationKind[] = ['email', 'phone', 'payment_method', 'identity', 'address', 'community'];
const asVerificationKind = (k: string): VerificationKind | null =>
  (VERIFICATION_KINDS as readonly string[]).includes(k) ? (k as VerificationKind) : null;

export interface MemberTrustProfile {
  reviews: ReviewSummary;
  trust: TrustResult;
}

/**
 * Load a member's public trust profile: aggregate the reviews they've received
 * and combine them with their verified badges + extra signals into a trust score.
 * `signals` lets the caller pass counts it already has (completed transactions,
 * disputes, cancellations, response time) so we don't re-query them here.
 */
export async function loadMemberTrust(
  sb: DB,
  args: { familyId: string; userId?: string | null; memberId?: string | null; signals?: Partial<TrustSignals> },
): Promise<MemberTrustProfile> {
  const empty: MemberTrustProfile = {
    reviews: aggregateReviews([]),
    trust: computeTrustScore({ ...(args.signals ?? {}) }),
  };
  if (!args.userId && !args.memberId) return empty;

  const [reviewRes, verifRes] = await Promise.all([
    args.userId
      ? sb.from('marketplace_reviews').select('rating, role, body, created_at').eq('reviewee_user_id', args.userId)
      : Promise.resolve({ data: [], error: null }),
    sb.from('marketplace_verifications')
      .select('kind, status')
      .eq('family_id', args.familyId)
      .eq('status', 'verified')
      .eq(args.memberId ? 'member_id' : 'user_id', (args.memberId ?? args.userId) as string),
  ]);

  if (reviewRes.error || verifRes.error) {
    console.error('[marketplace] trust load failed', reviewRes.error ?? verifRes.error);
    return empty;
  }

  const reviews = aggregateReviews(
    (reviewRes.data ?? []).map((r): ReviewInput => ({ rating: Number(r.rating), role: r.role, body: r.body, createdAt: r.created_at })),
  );
  const verifications = (verifRes.data ?? [])
    .map((v) => asVerificationKind(v.kind))
    .filter((k): k is VerificationKind => k !== null);

  const trust = computeTrustScore({
    ...toTrustRatingSignals(reviews),
    verifications,
    ...(args.signals ?? {}),
  });

  return { reviews, trust };
}

// ── Checkout quote ─────────────────────────────────────────────────────────

/** Platform commission when a family hasn't configured one (10%). */
export const DEFAULT_COMMISSION_BPS = 1000;

export interface CheckoutQuoteArgs {
  familyId: string;
  listingId: string;
  promo?: PromoOverride | null;
  depositCents?: number;
  taxCents?: number;
}

export interface CheckoutQuote {
  listing: { id: string; title: string; priceCents: number; category: string; currency: string };
  breakdown: FeeBreakdown;
}

/**
 * Build a checkout fee quote for a listing: read the listing + the family's
 * marketplace settings (commission), then run the fee engine to produce the full
 * transparent breakdown shown before checkout. Returns null if the listing is
 * gone. The commission falls back to the platform default when unconfigured.
 */
export async function loadCheckoutQuote(sb: DB, args: CheckoutQuoteArgs): Promise<CheckoutQuote | null> {
  const [listingRes, settingsRes] = await Promise.all([
    sb.from('marketplace_listings').select('id, title, price_cents, category').eq('id', args.listingId).maybeSingle(),
    sb.from('marketplace_settings').select('commission_bps, default_currency').eq('family_id', args.familyId).maybeSingle(),
  ]);
  if (listingRes.error || !listingRes.data) {
    if (listingRes.error) console.error('[marketplace] checkout quote: listing load failed', listingRes.error);
    return null;
  }
  const listing = listingRes.data;
  const settings = settingsRes.error ? null : settingsRes.data;

  const bps = settings?.commission_bps ?? DEFAULT_COMMISSION_BPS;
  const currency = settings?.default_currency ?? 'USD';
  const policy: CommissionPolicy = { default: { kind: 'percentage', bps } };

  const breakdown = computeFees({
    subtotalCents: listing.price_cents,
    policy,
    category: listing.category,
    promo: args.promo,
    depositCents: args.depositCents,
    taxCents: args.taxCents,
  });

  return {
    listing: { id: listing.id, title: listing.title, priceCents: listing.price_cents, category: listing.category, currency },
    breakdown,
  };
}

export interface OrderPartiesArgs {
  familyId: string;
  buyerUserId?: string | null;
  buyerMemberId?: string | null;
  sellerUserId?: string | null;
  sellerMemberId?: string | null;
  mode?: string;
  fulfillment?: string | null;
  offerId?: string | null;
  createdBy?: string | null;
}

/**
 * Map a server-computed checkout quote into a `marketplace_orders` insert row.
 * Pure: amounts come straight from the quote's breakdown (never the client), and
 * the order starts `pending` — no charge is implied until payment is confirmed.
 */
export function orderInsertFromQuote(quote: CheckoutQuote, parties: OrderPartiesArgs): OrderInsert {
  const b = quote.breakdown;
  return {
    family_id: parties.familyId,
    listing_id: quote.listing.id,
    offer_id: parties.offerId ?? null,
    buyer_user_id: parties.buyerUserId ?? null,
    buyer_member_id: parties.buyerMemberId ?? null,
    seller_user_id: parties.sellerUserId ?? null,
    seller_member_id: parties.sellerMemberId ?? null,
    mode: parties.mode ?? 'buy',
    fulfillment: parties.fulfillment ?? null,
    subtotal_cents: b.subtotalCents,
    fee_cents: b.marketplaceFeeCents + b.serviceFeeCents,
    deposit_cents: b.depositCents,
    tax_cents: b.taxCents,
    total_cents: b.buyerTotalCents,
    currency: quote.listing.currency,
    status: 'pending',
    created_by: parties.createdBy ?? null,
    metadata: {},
  };
}
