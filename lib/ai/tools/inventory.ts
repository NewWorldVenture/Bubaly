// Home inventory tools — "where's the passport?" answered from the family's
// own catalogue, and the move that keeps the answer true.
//
// `inventory.find` is a read over `inventory_items` + `home_locations`
// through the same finder the Home Inventory page uses, so the assistant and
// the page never disagree about where the ski helmet is. It returns the full
// room › container path and when the item was last confirmed or moved,
// because "in the garage" without "last checked in March" is a guess dressed
// as an answer. `inventory.recordMove` writes the relocation (or, with
// `confirm`, that the item is still where it is) to `inventory_moves`, the
// row the item card reads "last confirmed" from.
//
// Trust domain: `home_maintenance`. The taxonomy has no inventory domain and
// adding one would mean editing an enum every stored policy is written
// against; the catalogue is part of the physical home, so it is evaluated
// with the rest of it.
import 'server-only';
import { z } from 'zod';
import { confirmItem, findItems, recordMove, resolveLocationByName } from '@/lib/services/inventory';
import { scopeNow } from '@/lib/services/scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { defineTool, describeDay, plural, type ToolDefinition } from './types';

const findShape = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  quantity: z.number().int(),
  status: z.string(),
  lent_to: z.string().nullable(),
  /** "Garage › Shelf B › Box 3" or "No location yet". */
  where: z.string(),
  path: z.array(z.string()),
  location_id: z.string().nullable(),
  matched: z.array(z.string()),
  last_confirmed_at: z.string().nullable(),
  /** "Tuesday" / "Sat, Mar 3" — the confirmation day in the family's zone, or null. */
  last_confirmed: z.string().nullable(),
  last_moved_at: z.string().nullable(),
});

type Find = z.infer<typeof findShape>;

/**
 * Resolve the item a person named to an id: the top finder hit, unless two
 * hits tie for the top score — then it is a question, not a guess.
 */
async function resolveItemId(scope: ServiceScope, input: { item_id?: string | null; item?: string | null }): Promise<ServiceResult<string>> {
  if (input.item_id) return ok(input.item_id);
  const name = input.item?.trim();
  if (!name) return fail('Say which item.', { code: SERVICE_CODES.invalidInput });
  const found = await findItems(scope, { query: name, limit: 3 });
  if (!found.ok) return found;
  const [best, next] = found.data;
  if (!best) return fail(`Nothing in the inventory matches "${name}".`, { code: SERVICE_CODES.notFound });
  if (next && next.score === best.score) {
    return fail(`"${name}" could be ${best.item.name} or ${next.item.name} — say which one.`, { code: SERVICE_CODES.invalidInput });
  }
  return ok(best.item.id);
}

function describeHit(hit: Find): string {
  const bits = [`${hit.name}: ${hit.where}`];
  if (hit.status === 'lent') bits.push(`lent out${hit.lent_to ? ` to ${hit.lent_to}` : ''}`);
  else if (hit.status !== 'in_place') bits.push(hit.status.replace('_', ' '));
  if (hit.last_confirmed) bits.push(`confirmed ${hit.last_confirmed}`);
  return bits.join(' — ');
}

export const inventoryTools: ToolDefinition[] = [
  defineTool({
    name: 'inventory.find',
    aliases: ['find_item', 'where_is', 'find_in_inventory'],
    description: 'Find where something is kept, from the family\'s home inventory: "where is the passport / ski helmet / spare key". Returns the room › container path and when it was last confirmed there.',
    domain: 'home_maintenance',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      query: z.string().describe('What to look for, in the family\'s words'),
      limit: z.number().int().nullish().describe('How many matches to return; defaults to 5'),
    }),
    output: z.object({ found: z.boolean(), items: z.array(findShape) }),
    summarize: (input, output) => (output.items.length === 0
      ? `Nothing in the inventory matches "${input.query}"`
      : output.items.length === 1
        ? describeHit(output.items[0])
        : `${plural(output.items.length, 'match', 'matches')} for "${input.query}"; best is ${describeHit(output.items[0])}`),
    execute: async (scope, input) => {
      const res = await findItems(scope, { query: input.query, limit: input.limit ?? null });
      if (!res.ok) return res;
      const now = scopeNow(scope);
      return ok({
        found: res.data.length > 0,
        items: res.data.map((hit) => ({
          id: hit.item.id, name: hit.item.name, category: hit.item.category, quantity: hit.item.quantity, status: hit.item.status, lent_to: hit.item.lent_to,
          where: hit.where, path: hit.path, location_id: hit.item.location_id, matched: hit.matched,
          last_confirmed_at: hit.lastConfirmed?.at ?? null,
          last_confirmed: hit.lastConfirmed ? describeDay(hit.lastConfirmed.at, scope.tz, now) : null,
          last_moved_at: hit.lastMovedAt,
        })),
      });
    },
  }),

  defineTool({
    name: 'inventory.recordMove',
    aliases: ['record_inventory_move', 'move_item', 'confirm_item_location'],
    description: 'Log that an item moved to another room or container, or (with confirm) that it is still where the inventory says. Name the item and the place; ids are optional.',
    domain: 'home_maintenance',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      item: z.string().nullish().describe('The item, in the family\'s words, when the id is unknown'),
      item_id: z.string().nullish(),
      to_location: z.string().nullish().describe('The room or container it is in now, by name'),
      to_location_id: z.string().nullish(),
      confirm: z.boolean().nullish().describe('True to record that the item is still where it is, without moving it'),
      reason: z.string().nullish().describe('Why it moved, e.g. "spring clean"'),
    }),
    output: z.object({
      move_id: z.string(),
      item_id: z.string(),
      name: z.string(),
      confirmed: z.boolean(),
      from: z.string(),
      where: z.string(),
      moved_at: z.string(),
    }),
    idempotencyFrom: (input) => {
      const item = (input.item_id ?? input.item ?? '').trim().toLowerCase();
      if (!item) return null;
      return `inventory.recordMove:${item}:${input.confirm ? 'confirm' : (input.to_location_id ?? input.to_location ?? '').trim().toLowerCase()}`;
    },
    summarize: (_input, output) => (output.confirmed
      ? `Confirmed ${output.name} is still in ${output.where}`
      : `Moved ${output.name} to ${output.where}`),
    consequences: (input) => [input.confirm
      ? 'The item card will show today as the last time it was confirmed.'
      : 'The inventory will show the item in its new place, and the old place in its history.'],
    resource: (output) => ({ table: 'inventory_moves', id: output.move_id }),
    execute: async (scope, input) => {
      const itemId = await resolveItemId(scope, input);
      if (!itemId.ok) return itemId;

      if (input.confirm) {
        const res = await confirmItem(scope, { itemId: itemId.data });
        if (!res.ok) return res;
        return ok({ move_id: res.data.move.id, item_id: res.data.item.id, name: res.data.item.name, confirmed: true, from: res.data.from, where: res.data.where, moved_at: res.data.move.moved_at });
      }

      let toLocationId = input.to_location_id ?? null;
      if (!toLocationId) {
        const name = input.to_location?.trim();
        if (!name) return fail('Say where the item is now, or set confirm to record that it has not moved.', { code: SERVICE_CODES.invalidInput });
        const location = await resolveLocationByName(scope, name);
        if (!location.ok) return location;
        if (!location.data) return fail(`There is no room or container called "${name}" in the inventory yet.`, { code: SERVICE_CODES.notFound });
        toLocationId = location.data.id;
      }
      const res = await recordMove(scope, { itemId: itemId.data, toLocationId, reason: input.reason ?? null });
      if (!res.ok) return res;
      return ok({ move_id: res.data.move.id, item_id: res.data.item.id, name: res.data.item.name, confirmed: false, from: res.data.from, where: res.data.where, moved_at: res.data.move.moved_at });
    },
    verify: async (scope, _input, output) => {
      const { data, error } = await scope.db
        .from('inventory_moves')
        .select('id, to_location_id')
        .eq('id', output.move_id)
        .eq('family_id', scope.familyId)
        .maybeSingle();
      if (error) {
        console.error('[tool:inventory.recordMove] verification read failed', error);
        return fail('Could not confirm the move was logged.', { code: SERVICE_CODES.db });
      }
      return ok({ verified: Boolean(data), detail: data ? `${output.name} is logged in ${output.where}.` : 'The move is not on file.' });
    },
  }),
];
