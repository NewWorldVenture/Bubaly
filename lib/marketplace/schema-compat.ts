// lib/marketplace/schema-compat.ts — marketplace reads on either side of the
// proposed economy SQL.
//
// That proposal (proposed-economy.sql, not yet numbered or in
// supabase/migrations) changes two things the CURRENT app reads:
//
//   section 2   marketplace_orders.buyer_family_id. Orders from an auction,
//               Buy-It-Now or an accepted negotiation carry the SELLER's
//               family_id, so the winning household could not read its own
//               order. After the SQL, either family reads it.
//   section 8c  public.marketplace_circle_listings. The whole-row circle read
//               policy on marketplace_listings goes, and a circle sees another
//               family's shared listing only through this view, which has the
//               shopper-facing columns alone.
//
// Production applies SQL by hand and may lag the app, so every read here works
// on both schemas. The new read runs first; only when the answer says that
// exactly this object is missing (PGRST204/42703 for the column, PGRST205/42P01
// for the view, recognised by isMissingSchemaObject, the helper the messaging
// fallbacks use) does the read go back to what the app did before, with one
// console warning per object. Any other error goes back to the caller as the
// failure it is. Once the SQL is applied everywhere the fallbacks are
// unreachable and can be removed.
import { isMissingSchemaObject, type SchemaObjectRef } from '@/lib/messages/schema-compat';

export const MARKETPLACE_SCHEMA = {
  buyerFamily: { kind: 'column', table: 'marketplace_orders', name: 'buyer_family_id' },
  circleListings: { kind: 'table', name: 'marketplace_circle_listings' },
} as const satisfies Record<string, SchemaObjectRef>;

const PROPOSAL = 'the proposed economy SQL (proposed-economy.sql) has not been applied to this database';

const warned = new Set<string>();

function describe(object: SchemaObjectRef): string {
  return object.kind === 'column' ? `column public.${object.table}.${object.name}` : `view public.${object.name}`;
}

/** True, with one warning per object, when `error` is exactly `object` missing. */
function fellBackForMissing(error: unknown, object: SchemaObjectRef, fallback: string): boolean {
  if (!isMissingSchemaObject(error, object)) return false;
  const key = describe(object);
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[marketplace] ${key} is missing: ${PROPOSAL}. ${fallback}`);
  }
  return true;
}

/** Test seam: forget which warnings were already printed. */
export function resetMarketplaceSchemaWarnings(): void {
  warned.clear();
}

type ReadError = { code?: string; message: string } | null;
export type ReadResult<T> = { data: T | null; error: ReadError };

// ── Orders: the family on either side of the exchange ───────────────────────

/** PostgREST `or` filter: the order is the seller family's or the buyer family's. */
export function eitherPartyFamily(familyId: string): string {
  return `family_id.eq.${familyId},buyer_family_id.eq.${familyId}`;
}

type ScopableOrders<Q> = { or(filters: string): Q; eq(column: 'family_id', value: string): Q };

/** Narrows an order query to one family, by `scope` from readFamilyOrders. */
export type OrderFamilyScope = <Q extends ScopableOrders<Q>>(query: Q) => Q;

/**
 * Read `marketplace_orders` as the family on EITHER side of the exchange:
 * `family_id = familyId OR buyer_family_id = familyId`. `run` builds the query
 * and passes it through `scope` where it used to write
 * `.eq('family_id', familyId)`. On a database without buyer_family_id the same
 * query runs again with that `.eq`, which is exactly the read before this file.
 */
export async function readFamilyOrders<R extends { error: unknown }>(
  familyId: string,
  run: (scope: OrderFamilyScope) => PromiseLike<R>,
): Promise<R> {
  const current = await run((query) => query.or(eitherPartyFamily(familyId)));
  if (!fellBackForMissing(current.error, MARKETPLACE_SCHEMA.buyerFamily, 'Orders are read by the seller family only.')) {
    return current;
  }
  return run((query) => query.eq('family_id', familyId));
}

// ── Listings another family shared into a circle ────────────────────────────

export const CIRCLE_LISTINGS_VIEW = MARKETPLACE_SCHEMA.circleListings.name;

/** Every column public.marketplace_circle_listings exposes. */
export const CIRCLE_LISTING_COLUMNS: readonly string[] = [
  'id', 'family_id', 'family_name',
  'title', 'description', 'kind', 'category', 'condition',
  'price_cents', 'rent_period', 'photo_url', 'status',
  'sale_format', 'starting_bid_cents', 'buy_now_cents', 'current_bid_cents',
  'bid_count', 'has_reserve', 'reserve_met', 'highest_bidder_family_id',
  'auction_starts_at', 'auction_ends_at', 'anti_snipe_minutes', 'auction_closed_at',
  'created_at', 'updated_at',
];

/**
 * `columns`, unchanged, once every name in it is one the view exposes. A read
 * that asked the view for `location` or `member_id` would fail on every
 * database the SQL has reached, so it is refused here, where a test sees it.
 */
export function circleColumns<C extends string>(columns: C): C {
  const extra = columns.split(',').map((c) => c.trim()).filter((c) => c && !CIRCLE_LISTING_COLUMNS.includes(c));
  if (extra.length) throw new Error(`circleColumns: ${CIRCLE_LISTINGS_VIEW} does not expose ${extra.join(', ')}`);
  return columns;
}

/**
 * Read other families' listings through the view; on a database without it,
 * run `legacy`, the table read the app made before. `via` says which ran, so a
 * caller that adds its own family's rows from the table knows whether the
 * legacy read already included them.
 */
export async function readCircleOrLegacy<T>(
  viaView: () => PromiseLike<ReadResult<T>>,
  legacy: () => PromiseLike<ReadResult<T>>,
): Promise<ReadResult<T> & { via: 'view' | 'table' }> {
  const shared = await viaView();
  if (!fellBackForMissing(shared.error, MARKETPLACE_SCHEMA.circleListings, 'Circle listings are read from marketplace_listings.')) {
    return { ...shared, via: 'view' };
  }
  return { ...(await legacy()), via: 'table' };
}

/**
 * One listing whose family is not known up front. The table answers for the
 * caller's own family (and, before the SQL, for circle listings too, through
 * the old policy); a row it does not return is looked for in the view. When
 * the view is missing the table's answer stands, which is today's read.
 */
export async function readListingAnyFamily<T>(
  viaTable: () => PromiseLike<ReadResult<T>>,
  viaView: () => PromiseLike<ReadResult<T>>,
): Promise<ReadResult<T>> {
  const own = await viaTable();
  if (own.error || own.data != null) return own;
  const shared = await readCircleOrLegacy(viaView, async () => own);
  return { data: shared.data, error: shared.error };
}
