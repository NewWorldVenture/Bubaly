// lib/marketplace/matching-server.ts — persist request→listing matches. Loads a
// wanted request + the publicly discoverable listings, runs the matching engine,
// and rewrites that request's rows in marketplace_request_matches. Idempotent:
// prior suggestions for the request are cleared before the fresh set is written.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { matchRequest, type MatchListing, type MatchRequest, type MatchResult, type MatchMode } from './matching';

type DB = SupabaseClient<Database>;
type RequestRow = Database['public']['Tables']['marketplace_requests']['Row'];
type ListingRow = Database['public']['Tables']['marketplace_listings']['Row'];
type MatchInsert = Database['public']['Tables']['marketplace_request_matches']['Insert'];

const asMode = (m: string | null): MatchMode | undefined =>
  (m === 'buy' || m === 'rent' || m === 'borrow' || m === 'any' ? m : undefined);

/** Map a marketplace_requests row into the engine's MatchRequest shape. */
export function requestToMatchRequest(r: RequestRow): MatchRequest {
  return {
    title: r.title,
    description: r.description,
    itemType: r.item_type,
    preferredMode: asMode(r.preferred_mode),
    size: r.size,
    color: r.color,
    brand: r.brand,
    condition: r.condition,
    budgetCents: r.budget_cents,
    radiusMiles: r.radius_miles,
  };
}

/** Map a marketplace_listings row into the engine's MatchListing shape. */
export function listingRowToMatchListing(l: ListingRow): MatchListing {
  return {
    id: l.id,
    title: l.title,
    description: l.description,
    category: l.category,
    subcategory: l.subcategory,
    modes: l.modes,
    kind: l.kind,
    size: l.size,
    color: l.color,
    brand: l.brand,
    condition: l.condition,
    priceCents: l.price_cents,
    latitude: l.latitude,
    longitude: l.longitude,
    status: l.status,
    visibility: l.visibility,
  };
}

/** Map a scored match into a marketplace_request_matches insert row. */
export function matchToInsert(familyId: string, requestId: string, result: MatchResult): MatchInsert {
  return {
    family_id: familyId,
    request_id: requestId,
    listing_id: result.listing.id,
    score: result.score,
    reason: result.reasons.slice(0, 5).join(' · ') || null,
    status: 'suggested',
  };
}

const LISTING_COLS =
  'id, title, description, category, subcategory, modes, kind, size, color, brand, condition, price_cents, latitude, longitude, status, visibility';

/**
 * Recompute and persist the best matches for a wanted request. Returns the
 * ranked results and how many were saved. No-ops (0 saved) if the request is
 * gone.
 */
export async function saveRequestMatches(
  sb: DB, requestId: string, opts: { limit?: number } = {},
): Promise<{ matches: MatchResult[]; saved: number }> {
  const { data: req, error: reqErr } = await sb
    .from('marketplace_requests').select('*').eq('id', requestId).maybeSingle();
  if (reqErr || !req) return { matches: [], saved: 0 };

  const { data: listings, error: listErr } = await sb
    .from('marketplace_listings')
    .select(LISTING_COLS)
    .eq('visibility', 'public')
    .in('status', ['available', 'pending'])
    .is('deleted_at', null)
    .limit(500);
  if (listErr) {
    console.error('[marketplace] match: listing load failed', listErr);
    return { matches: [], saved: 0 };
  }

  const results = matchRequest(
    requestToMatchRequest(req),
    (listings ?? []).map((l) => listingRowToMatchListing(l as ListingRow)),
    { limit: opts.limit ?? 20 },
  );

  // Idempotent rewrite: clear this request's prior suggestions, then insert fresh.
  await sb.from('marketplace_request_matches').delete().eq('request_id', requestId);
  if (results.length > 0) {
    await sb.from('marketplace_request_matches').insert(results.map((r) => matchToInsert(req.family_id, requestId, r)));
  }
  return { matches: results, saved: results.length };
}
