// lib/marketplace/circle-reads.ts — the marketplace reads that serve OTHER
// families' listings, on either side of the proposed economy SQL (8c).
//
// Before it, marketplace_listings_circle_read (0178) let a circle read another
// family's whole listing row from the table. After it, that policy is gone and
// the cross-family read goes through public.marketplace_circle_listings, which
// exposes only shopper-facing columns. The caller's own family keeps reading
// the table. Each reader here asks the view only for columns it has
// (circleColumns), and falls back to today's table read when the view is
// missing (lib/marketplace/schema-compat.ts).
import type { SupabaseServer } from '@/lib/supabase/types';
import type { ShareLite, SharedListingLite } from './community';
import { RESERVE_VIEW_COLUMNS, readWithReserveView } from './reserve-view';
import {
  CIRCLE_LISTINGS_VIEW, circleColumns, readCircleOrLegacy, readListingAnyFamily, type ReadResult,
} from './schema-compat';

type Client = Pick<SupabaseServer, 'from'>;

/**
 * A query on public.marketplace_circle_listings. The view is not in
 * lib/database.types.ts, which declares only what supabase/migrations creates,
 * so it is typed as the table it projects: every column it exposes is the
 * table's (family_name aside, which nothing here reads), and circleColumns
 * refuses a column list that names anything else.
 */
const fromCircleView = (sb: Client) => sb.from(CIRCLE_LISTINGS_VIEW as 'marketplace_listings');

// ── The live auctions board ──────────────────────────────────────────────────

export const LIVE_AUCTION_COLUMNS = `id, title, photo_url, category, sale_format, status, starting_bid_cents, current_bid_cents, bid_count, ${RESERVE_VIEW_COLUMNS}, buy_now_cents, auction_starts_at, auction_ends_at`;
export const LIVE_AUCTION_LIMIT = 60;

export type LiveAuctionRow = {
  id: string; title: string; photo_url: string | null; category: string;
  sale_format: string; status: string; starting_bid_cents: number; current_bid_cents: number;
  bid_count: number; has_reserve: boolean; reserve_met: boolean; buy_now_cents: number | null;
  auction_starts_at: string | null; auction_ends_at: string | null;
};

/**
 * Open auctions the family can reach, soonest-ending first: its own from the
 * table, other families' from the view. Without the view, the single table
 * read RLS answered with both, as before.
 */
export async function readLiveAuctions(sb: Client, familyId: string, nowIso: string): Promise<ReadResult<LiveAuctionRow[]>> {
  const shared = await readCircleOrLegacy<LiveAuctionRow[]>(
    () => readWithReserveView(circleColumns(LIVE_AUCTION_COLUMNS), (columns) => fromCircleView(sb)
      .select(columns)
      .neq('family_id', familyId)
      .eq('sale_format', 'auction').eq('status', 'available')
      .gt('auction_ends_at', nowIso)
      .order('auction_ends_at', { ascending: true })
      .limit(LIVE_AUCTION_LIMIT)),
    () => readWithReserveView(LIVE_AUCTION_COLUMNS, (columns) => sb
      .from('marketplace_listings').select(columns)
      .eq('sale_format', 'auction').eq('status', 'available')
      .gt('auction_ends_at', nowIso)
      .order('auction_ends_at', { ascending: true })
      .limit(LIVE_AUCTION_LIMIT)),
  );
  if (shared.via === 'table' || shared.error) return { data: shared.data, error: shared.error };

  const own = await readWithReserveView<LiveAuctionRow[]>(LIVE_AUCTION_COLUMNS, (columns) => sb
    .from('marketplace_listings').select(columns)
    .eq('family_id', familyId)
    .eq('sale_format', 'auction').eq('status', 'available')
    .gt('auction_ends_at', nowIso)
    .order('auction_ends_at', { ascending: true })
    .limit(LIVE_AUCTION_LIMIT));
  if (own.error) return own;

  const rows = [...(own.data ?? []), ...(shared.data ?? [])]
    .sort((a, b) => (a.auction_ends_at ?? '').localeCompare(b.auction_ends_at ?? ''))
    .slice(0, LIVE_AUCTION_LIMIT);
  return { data: rows, error: null };
}

// ── The community feed ───────────────────────────────────────────────────────

export const SHARED_LISTING_COLUMNS = 'id, title, kind, category, condition, price_cents, rent_period, status, family_id';

/**
 * The listings behind a circle's shares: the family's own from the table,
 * everyone else's from the view. Without the view, one table read of every id,
 * which the 0178 circle-read policy answered across families.
 */
export async function readSharedListings(
  sb: Client, familyId: string, shares: readonly ShareLite[],
): Promise<ReadResult<SharedListingLite[]>> {
  const ids = [...new Set(shares.map((s) => s.listing_id))];
  if (!ids.length) return { data: [], error: null };
  const ownIds = [...new Set(shares.filter((s) => s.family_id === familyId).map((s) => s.listing_id))];
  const otherIds = ids.filter((id) => !ownIds.includes(id));

  const shared: ReadResult<SharedListingLite[]> & { via: 'view' | 'table' } = otherIds.length
    ? await readCircleOrLegacy<SharedListingLite[]>(
      () => fromCircleView(sb).select(circleColumns(SHARED_LISTING_COLUMNS)).in('id', otherIds),
      () => sb.from('marketplace_listings').select(SHARED_LISTING_COLUMNS).in('id', ids),
    )
    : { data: [], error: null, via: 'view' };
  if (shared.via === 'table' || shared.error) return { data: shared.data, error: shared.error };

  const own = ownIds.length
    ? await sb.from('marketplace_listings').select(SHARED_LISTING_COLUMNS).eq('family_id', familyId).in('id', ownIds)
    : { data: [], error: null };
  if (own.error) return { data: null, error: own.error };
  return { data: [...(own.data ?? []), ...(shared.data ?? [])], error: null };
}

// ── One auction ──────────────────────────────────────────────────────────────

export const AUCTION_STATE_COLUMNS = `sale_format, status, starting_bid_cents, current_bid_cents, bid_count, ${RESERVE_VIEW_COLUMNS}, buy_now_cents, auction_starts_at, auction_ends_at, highest_bidder_family_id`;

export type AuctionStateRow = {
  sale_format: string; status: string; starting_bid_cents: number; current_bid_cents: number;
  bid_count: number; has_reserve: boolean; reserve_met: boolean; buy_now_cents: number | null;
  auction_starts_at: string | null; auction_ends_at: string | null; highest_bidder_family_id: string | null;
};

/**
 * The auction panel's live state. The seller's own family reads the table; a
 * viewer from another family gets it from the view when the table no longer
 * returns the row.
 */
export async function readAuctionState(
  sb: Client, listingId: string, { ownFamily }: { ownFamily: boolean },
): Promise<ReadResult<AuctionStateRow>> {
  const viaTable = () => readWithReserveView<AuctionStateRow>(AUCTION_STATE_COLUMNS, (columns) => sb
    .from('marketplace_listings').select(columns).eq('id', listingId).maybeSingle());
  if (ownFamily) return viaTable();
  return readListingAnyFamily(viaTable, () => readWithReserveView<AuctionStateRow>(circleColumns(AUCTION_STATE_COLUMNS), (columns) => fromCircleView(sb)
    .select(columns).eq('id', listingId).maybeSingle()));
}

export const BID_TARGET_COLUMNS = 'id, highest_bidder_family_id, bid_count';

export type BidTargetRow = { id: string; highest_bidder_family_id: string | null; bid_count: number };

/** What placeBidAction and buyNowAction check before the RPC: another family's listing, usually. */
export async function readBidTarget(sb: Client, listingId: string): Promise<ReadResult<BidTargetRow>> {
  return readListingAnyFamily<BidTargetRow>(
    () => sb.from('marketplace_listings').select(BID_TARGET_COLUMNS).eq('id', listingId).maybeSingle(),
    () => fromCircleView(sb).select(circleColumns(BID_TARGET_COLUMNS)).eq('id', listingId).maybeSingle(),
  );
}

// ── Titles on the orders page ────────────────────────────────────────────────

/**
 * Rows for listings the table did not return: on an order the family WON, or
 * an offer it made, the listing is another family's. From the view when it
 * exists, asking only for `columns` it exposes; without it there is nothing
 * more to read (the table read already had the old policy's reach).
 */
export async function readCircleListingsById<T extends { id: string }>(
  sb: Client, ids: readonly string[], columns: string,
): Promise<ReadResult<T[]>> {
  if (!ids.length) return { data: [], error: null };
  const shared = await readCircleOrLegacy<T[]>(
    () => fromCircleView(sb).select(circleColumns(columns)).in('id', [...ids]) as unknown as PromiseLike<ReadResult<T[]>>,
    async () => ({ data: [], error: null }),
  );
  return { data: shared.data, error: shared.error };
}

/** Titles for listings the table did not return (readCircleListingsById). */
export async function readCircleTitles(sb: Client, ids: readonly string[]): Promise<ReadResult<{ id: string; title: string }[]>> {
  return readCircleListingsById<{ id: string; title: string }>(sb, ids, 'id, title');
}

// ── One listing's page ───────────────────────────────────────────────────────

/** What the listing page reads of a listing in the viewer's own family. */
export const LISTING_DETAIL_COLUMNS = `id, family_id, member_id, title, description, kind, category, condition, price_cents, rent_period, photo_url, location, status, created_at, sale_format, auction_starts_at, auction_ends_at, starting_bid_cents, ${RESERVE_VIEW_COLUMNS}, buy_now_cents, current_bid_cents, bid_count, highest_bidder_family_id`;

/** The same, of another family's listing: the view has no member_id or location, and names the family. */
export const CIRCLE_LISTING_DETAIL_COLUMNS = `id, family_id, family_name, title, description, kind, category, condition, price_cents, rent_period, photo_url, status, created_at, sale_format, auction_starts_at, auction_ends_at, starting_bid_cents, ${RESERVE_VIEW_COLUMNS}, buy_now_cents, current_bid_cents, bid_count, highest_bidder_family_id`;

export type ListingDetailRow = {
  id: string; family_id: string; member_id: string | null; family_name: string | null;
  title: string; description: string | null; kind: string; category: string; condition: string | null;
  price_cents: number; rent_period: string | null; photo_url: string | null; location: string | null;
  status: string; created_at: string; sale_format: string; auction_starts_at: string | null; auction_ends_at: string | null;
  starting_bid_cents: number; has_reserve: boolean; reserve_met: boolean; buy_now_cents: number | null;
  current_bid_cents: number; bid_count: number; highest_bidder_family_id: string | null;
};

/**
 * The listing behind /marketplace/item/[id], whichever family it is: the
 * viewer's own from the table, another family's from the circle view (or, on a
 * database without the view, the table read the old circle policy answered).
 * `ownFamily` says which, so the page treats the viewer of another family's
 * listing as a shopper. That listing comes back without its seller member and
 * its pickup location on either schema: the view does not carry them, and the
 * page does not show one family's pickup spot to another.
 */
export async function readListingDetail(
  sb: Client, listingId: string, familyId: string,
): Promise<ReadResult<ListingDetailRow> & { ownFamily: boolean }> {
  const own = await readWithReserveView<ListingDetailRow>(LISTING_DETAIL_COLUMNS, (columns) => sb
    .from('marketplace_listings').select(columns).eq('id', listingId).eq('family_id', familyId).maybeSingle());
  if (own.error) return { data: null, error: own.error, ownFamily: false };
  if (own.data) return { data: { ...own.data, family_name: null }, error: null, ownFamily: true };

  const other = await readCircleOrLegacy<ListingDetailRow>(
    () => readWithReserveView(circleColumns(CIRCLE_LISTING_DETAIL_COLUMNS), (columns) => fromCircleView(sb)
      .select(columns).eq('id', listingId).neq('family_id', familyId).maybeSingle()),
    () => readWithReserveView(LISTING_DETAIL_COLUMNS, (columns) => sb
      .from('marketplace_listings').select(columns).eq('id', listingId).neq('family_id', familyId).maybeSingle()),
  );
  if (other.error || !other.data) return { data: null, error: other.error, ownFamily: false };
  return {
    data: { ...other.data, member_id: null, location: null, family_name: other.data.family_name ?? null },
    error: null,
    ownFamily: false,
  };
}

/**
 * The listing a report names, and its seller member when the caller's family
 * can see it (its own). Another family's listing comes from the view, which
 * has no member_id: the caller cannot be its seller, so null is the answer.
 */
export async function readReportTarget(sb: Client, listingId: string): Promise<ReadResult<{ id: string; member_id: string | null }>> {
  return readListingAnyFamily<{ id: string; member_id: string | null }>(
    () => sb.from('marketplace_listings').select('id, member_id').eq('id', listingId).maybeSingle(),
    async () => {
      const shared = await fromCircleView(sb).select(circleColumns('id')).eq('id', listingId).maybeSingle();
      return { data: shared.data ? { id: shared.data.id, member_id: null } : null, error: shared.error };
    },
  );
}
