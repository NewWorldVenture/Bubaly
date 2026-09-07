// Home inventory: "where is the passport?" answered from the family's own
// catalogue, and the two writes that keep the answer honest — a move when
// something changed rooms, a confirmation when someone checked it is still
// there.
//
// The search itself is `lib/inventory/finder.ts searchItems`, the same pure
// engine the Home Inventory module runs in the browser, so the assistant and
// the page agree on what "the passport" matches. This service only adds the
// reads (family-scoped, failing closed) and the move history that turns a hit
// into "in the top drawer, confirmed on Tuesday".
//
// Both writes land on `inventory_moves` (0242). A confirmation is a move with
// from = to and reason 'confirmed' — no schema change, and the item card, the
// finder and this service all read the same row back.
import 'server-only';
import type { Database, Tables } from '@/lib/database.types';
import {
  CONFIRM_REASON, lastConfirmed, lastMoved, locationLabel, locationPath, searchItems,
  type Confirmation, type ItemLike, type LocationLike, type MoveLike, type SearchHit,
} from '@/lib/inventory/finder';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { scopeNow } from '../scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type InventoryItemRow = Tables<'inventory_items'>;
export type HomeLocationRow = Tables<'home_locations'>;
export type InventoryMoveRow = Tables<'inventory_moves'>;

const MAX_ITEMS = 2000;
const MAX_LOCATIONS = 500;
const MAX_MOVES = 2000;
const DEFAULT_LIMIT = 5;

export type InventoryFind = {
  item: InventoryItemRow;
  /** "Garage › Shelf B › Box 3", or "No location yet". */
  where: string;
  /** The same path as a list, root first. */
  path: string[];
  matched: string[];
  score: number;
  lastConfirmed: Confirmation | null;
  lastMovedAt: string | null;
};

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (m) => `\\${m}`);
}

async function readLocations(scope: ServiceScope): Promise<ServiceResult<HomeLocationRow[]>> {
  const { data, error } = await scope.db
    .from('home_locations')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('name', { ascending: true })
    .limit(MAX_LOCATIONS);
  if (error) {
    console.error('[service:inventory] locations read failed', error);
    return fail(describeDbError(error, 'Could not load the rooms and containers.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

async function readItems(scope: ServiceScope): Promise<ServiceResult<InventoryItemRow[]>> {
  const { data, error } = await scope.db
    .from('inventory_items')
    .select('*')
    .eq('family_id', scope.familyId)
    .neq('status', 'disposed')
    .order('updated_at', { ascending: false })
    .limit(MAX_ITEMS);
  if (error) {
    console.error('[service:inventory] items read failed', error);
    return fail(describeDbError(error, 'Could not load the home inventory.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

async function readMovesFor(scope: ServiceScope, itemIds: string[]): Promise<ServiceResult<InventoryMoveRow[]>> {
  if (itemIds.length === 0) return ok([]);
  const { data, error } = await scope.db
    .from('inventory_moves')
    .select('*')
    .eq('family_id', scope.familyId)
    .in('item_id', itemIds)
    .order('moved_at', { ascending: false })
    .limit(MAX_MOVES);
  if (error) {
    console.error('[service:inventory] moves read failed', error);
    return fail(describeDbError(error, 'Could not load the move history.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

/** The rooms and containers, for a caller that needs to offer or resolve one. */
export async function listLocations(scope: ServiceScope): Promise<ServiceResult<HomeLocationRow[]>> {
  return readLocations(scope);
}

/**
 * "Where's the passport?" → the best matches with their full room › container
 * path and when each was last confirmed or moved. Every read fails closed: an
 * empty answer is only ever "the catalogue has no such item", never "the
 * database hiccupped".
 */
export async function findItems(scope: ServiceScope, input: { query: string; limit?: number | null }): Promise<ServiceResult<InventoryFind[]>> {
  const query = input.query?.trim() ?? '';
  if (!query) return fail('Say what you are looking for.', { code: SERVICE_CODES.invalidInput });
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 25);

  const [items, locations] = await Promise.all([readItems(scope), readLocations(scope)]);
  if (!items.ok) return items;
  if (!locations.ok) return locations;

  const hits: SearchHit<InventoryItemRow>[] = searchItems(items.data, locations.data as LocationLike[], query).slice(0, limit);
  const moves = await readMovesFor(scope, hits.map((h) => h.item.id));
  if (!moves.ok) return moves;

  return ok(hits.map((hit) => ({
    item: hit.item,
    where: hit.where,
    path: locationPath(locations.data as LocationLike[], hit.item.location_id),
    matched: hit.matched,
    score: hit.score,
    lastConfirmed: lastConfirmed(moves.data as MoveLike[], hit.item.id),
    lastMovedAt: lastMoved(moves.data as MoveLike[], hit.item.id)?.at ?? null,
  })));
}

/** One item by id, family-scoped. */
export async function getItem(scope: ServiceScope, itemId: string): Promise<ServiceResult<InventoryItemRow>> {
  if (!itemId?.trim()) return fail('Which item?', { code: SERVICE_CODES.invalidInput });
  const { data, error } = await scope.db
    .from('inventory_items')
    .select('*')
    .eq('family_id', scope.familyId)
    .eq('id', itemId)
    .maybeSingle();
  if (error) {
    console.error('[service:inventory] item read failed', error);
    return fail(describeDbError(error, 'Could not load that item.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That item is not in your inventory.', { code: SERVICE_CODES.notFound });
  return ok(data);
}

/**
 * Resolve a location the family named ("the garage", "top drawer") to a row.
 * Exact name first, then a unique partial match; two candidates is a question
 * for the person, not a coin toss.
 */
export async function resolveLocationByName(scope: ServiceScope, name: string): Promise<ServiceResult<HomeLocationRow | null>> {
  const term = name.trim().replace(/^(the|my|our)\s+/i, '');
  if (!term) return ok(null);
  const { data, error } = await scope.db
    .from('home_locations')
    .select('*')
    .eq('family_id', scope.familyId)
    .ilike('name', `%${escapeLike(term)}%`)
    .limit(10);
  if (error) {
    console.error('[service:inventory] location lookup failed', error);
    return fail(describeDbError(error, 'Could not look up that location.'), { code: SERVICE_CODES.db });
  }
  const rows = data ?? [];
  const exact = rows.filter((r) => r.name.trim().toLowerCase() === term.toLowerCase());
  if (exact.length === 1) return ok(exact[0]);
  if (rows.length === 1) return ok(rows[0]);
  if (rows.length > 1) {
    return fail(`"${name}" could be ${rows.slice(0, 4).map((r) => r.name).join(', ')} — say which one.`, { code: SERVICE_CODES.invalidInput });
  }
  return ok(null);
}

export type RecordMoveInput = {
  itemId: string;
  /** The new location; null when the item now has no location. */
  toLocationId: string | null;
  reason?: string | null;
};

export type RecordedMove = {
  move: InventoryMoveRow;
  item: InventoryItemRow;
  /** "Garage › Shelf B", after the move. */
  where: string;
  /** Where it was before, for the summary. */
  from: string;
};

/**
 * Log that an item moved: the item's location changes and a history row says
 * from where, to where, by whom and why. The item row is updated FIRST, so a
 * failed history insert leaves the catalogue right and reports the miss,
 * rather than a history line pointing at a place the item is not.
 */
export async function recordMove(scope: ServiceScope, input: RecordMoveInput): Promise<ServiceResult<RecordedMove>> {
  const item = await getItem(scope, input.itemId);
  if (!item.ok) return item;
  const locations = await readLocations(scope);
  if (!locations.ok) return locations;
  const to = input.toLocationId ?? null;
  if (to && !locations.data.some((l) => l.id === to)) {
    return fail('That location is not one of your rooms or containers.', { code: SERVICE_CODES.notFound });
  }
  const reason = input.reason?.trim() || null;
  return writeMove(scope, item.data, locations.data, item.data.location_id, to, reason, 'moved');
}

/**
 * "Yes, it is still here." Writes a move with from = to and reason
 * 'confirmed', which is how the item card derives "last confirmed" — nothing
 * is claimed that is not on file.
 */
export async function confirmItem(scope: ServiceScope, input: { itemId: string }): Promise<ServiceResult<RecordedMove>> {
  const item = await getItem(scope, input.itemId);
  if (!item.ok) return item;
  const locations = await readLocations(scope);
  if (!locations.ok) return locations;
  return writeMove(scope, item.data, locations.data, item.data.location_id, item.data.location_id, CONFIRM_REASON, 'confirmed');
}

async function writeMove(
  scope: ServiceScope,
  item: InventoryItemRow,
  locations: HomeLocationRow[],
  from: string | null,
  to: string | null,
  reason: string | null,
  kind: 'moved' | 'confirmed',
): Promise<ServiceResult<RecordedMove>> {
  if (kind === 'moved') {
    // A lost item that turns up somewhere is found; every other status stands.
    const patch: Database['public']['Tables']['inventory_items']['Update'] = { location_id: to, status: item.status === 'lost' ? 'in_place' : item.status };
    const { error } = await scope.db.from('inventory_items').update(patch).eq('family_id', scope.familyId).eq('id', item.id);
    if (error) {
      console.error('[service:inventory] item update failed', error);
      return fail(describeDbError(error, 'Could not update where the item is.'), { code: SERVICE_CODES.db });
    }
  }
  const { data, error } = await scope.db
    .from('inventory_moves')
    .insert({
      family_id: scope.familyId,
      item_id: item.id,
      from_location_id: from,
      to_location_id: to,
      moved_by: scope.memberId,
      moved_at: scopeNow(scope).toISOString(),
      reason,
      created_by: scope.userId,
    })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:inventory] move insert failed', error);
    return fail(describeDbError(error, kind === 'moved' ? 'The item was updated but the move could not be logged.' : 'Could not record the confirmation.'), { code: SERVICE_CODES.db });
  }

  const where = locationLabel(locations as LocationLike[], to);
  const fromLabel = locationLabel(locations as LocationLike[], from);
  await recordActivitySafely(scope, {
    agent: 'inventory',
    action: kind === 'moved' ? 'update' : 'create',
    title: kind === 'moved' ? `Moved ${item.name} to ${where}` : `Confirmed ${item.name} is in ${where}`,
    href: '/dashboard/inventory',
    resourceId: data.id,
  });
  const updated: InventoryItemRow = kind === 'moved' ? { ...item, location_id: to, status: item.status === 'lost' ? 'in_place' : item.status } : item;
  return ok({ move: data, item: updated, where, from: fromLabel });
}

/** Exported for the tools, so the item shape the assistant sees is the finder's. */
export type { ItemLike };
