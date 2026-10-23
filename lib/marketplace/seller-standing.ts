// lib/marketplace/seller-standing.ts — whether a listing's seller family is
// still open for business.
//
// A family that closed its account (families.closed_at) cannot see a sale, and
// every delivery cron skips its notices, so a bid or a Buy-It-Now on its
// listing committed the buyer to a seller who would hear nothing until they
// reopened — and Buy-It-Now created the order on the spot. The circle view and
// marketplace_listing_visible_to still serve and admit such a listing (closing
// that is the owner's SQL); the auction actions refuse the commitment with
// this, as cron/close-auctions refuses to settle one. So do the other ways a
// buyer commits to a seller: opening a negotiation, and countering or
// accepting one (an accepted thread is a confirmed order) — and, for the same
// reason, a seller accepting a buyer whose household has closed.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type Client = Pick<SupabaseClient<Database>, 'from'>;

export type SellerStanding = 'open' | 'closed' | 'unknown';

/**
 * The seller's standing for one listing, read with the SERVICE client: the
 * seller is another household, whose families row the buyer's own session
 * cannot read. The caller asks only about a listing its circle reader already
 * returned to the buyer, so the answer tells them nothing about a listing they
 * could not see. A listing this read no longer finds is 'open' — the RPC gives
 * its own not_found. 'unknown' when the read fails: an unreadable standing is
 * not an open seller.
 */
export async function readSellerStanding(service: Client, listingId: string): Promise<SellerStanding> {
  // Two reads, not an embed: marketplace_listings has two foreign keys into
  // families (family_id and highest_bidder_family_id), so `families(...)`
  // alone is ambiguous to PostgREST.
  const { data: listing, error } = await service
    .from('marketplace_listings').select('id, family_id').eq('id', listingId).maybeSingle();
  if (error) {
    console.error('[marketplace] seller standing read failed', { listingId, error });
    return 'unknown';
  }
  if (!listing) return 'open';
  return readFamilyStanding(service, listing.family_id);
}

/**
 * One household's standing, by id, with the SERVICE client — for a party the
 * caller already deals with (a negotiation's buyer family, which the thread
 * the caller's own session read names). 'open' for a family this read does not
 * find; 'unknown' when the read fails.
 */
export async function readFamilyStanding(service: Client, familyId: string): Promise<SellerStanding> {
  const { data: family, error } = await service
    .from('families').select('id, closed_at').eq('id', familyId).maybeSingle();
  if (error) {
    console.error('[marketplace] family standing read failed', { familyId, error });
    return 'unknown';
  }
  return family?.closed_at ? 'closed' : 'open';
}
