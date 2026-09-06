// Shopping-list tools.
//
// `add_grocery_item` (one item, `{item, quantity}`) is the legacy shape the
// assistant has used all along; the registry keeps it working while exposing
// the batch form the planner actually wants — "add everything this week's
// meals need" is one call, one activity line and one duplicate check, not
// fourteen.
//
// Clearing checked items is `delete` + medium risk on purpose: it removes rows
// the family cannot get back, but it is the ordinary end of a shopping trip,
// so it is not treated like deleting a calendar event.
import 'server-only';
import { z } from 'zod';
import { addItems, checkItem, clearChecked, listOpen } from '@/lib/services/groceries';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import { defineTool, plural, type ToolDefinition } from './types';

const itemOutput = z.object({
  id: z.string(),
  name: z.string(),
  quantity: z.string().nullable(),
  category: z.string().nullable(),
  is_checked: z.boolean(),
});

export const groceryTools: ToolDefinition[] = [
  defineTool({
    name: 'groceries.addItems',
    aliases: ['add_grocery_item', 'add_grocery_items', 'add_to_shopping_list'],
    description: 'Add one or more items to the family shopping list. Items already on the list unchecked are skipped.',
    domain: 'shopping',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      items: z.array(z.object({
        name: z.string(),
        quantity: z.string().nullish(),
        category: z.string().nullish().describe('Store aisle; guessed from the name when omitted'),
      })).nullish().describe('Batch form'),
      item: z.string().nullish().describe('Single-item form (legacy)'),
      // `add_grocery_item` has been emitted with the item under `name` since
      // `lib/ai/actions.ts` declared it that way to the model, and Magic Import
      // still sends that shape. Resolving the alias but then dropping the item
      // would be silent data loss, so both single-item spellings are accepted.
      name: z.string().nullish().describe('Single-item form; alternative spelling of `item`'),
      quantity: z.string().nullish().describe('Quantity for the single-item form'),
      list_id: z.string().nullish(),
    }),
    output: z.object({
      list_id: z.string(),
      added: z.array(itemOutput),
      skipped: z.array(z.string()).describe('Names already on the list'),
    }),
    idempotencyFrom: (input) => {
      const single = input.item ?? input.name ?? null;
      const names = (input.items ?? []).map((i) => i.name).concat(single ? [single] : [])
        .map((n) => n.trim().toLowerCase()).filter(Boolean).sort();
      return names.length ? `groceries.addItems:${names.join('|')}` : null;
    },
    summarize: (_input, output) => {
      const added = output.added.length === 1
        ? `Added ${output.added[0].name} to the shopping list`
        : `Added ${plural(output.added.length, 'item')} to the shopping list`;
      return output.skipped.length ? `${added} (${output.skipped.join(', ')} already on it)` : added;
    },
    execute: async (scope, input) => {
      const items = [
        ...(input.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity ?? null, category: i.category ?? null })),
        ...((input.item ?? input.name) ? [{ name: (input.item ?? input.name)!, quantity: input.quantity ?? null, category: null }] : []),
      ];
      if (items.length === 0) return fail('There was nothing to add to the list.', { code: SERVICE_CODES.invalidInput });

      const res = await addItems(scope, { items, listId: input.list_id ?? null });
      if (!res.ok) return res;
      return ok({
        list_id: res.data.listId,
        added: res.data.added.map((row) => ({
          id: row.id, name: row.name, quantity: row.quantity, category: row.category, is_checked: row.is_checked,
        })),
        skipped: res.data.skipped,
      });
    },
    verify: async (scope, _input, output) => {
      if (output.added.length === 0) {
        return ok({ verified: true, detail: 'Everything requested was already on the list.' });
      }
      const { data, error } = await scope.db
        .from('grocery_items')
        .select('id')
        .eq('family_id', scope.familyId)
        .in('id', output.added.map((item) => item.id));
      if (error) {
        console.error('[tool:groceries.addItems] verification read failed', error);
        return fail(describeDbError(error, 'Could not confirm the items were saved.'), { code: SERVICE_CODES.db });
      }
      const found = (data ?? []).length;
      return ok({
        verified: found === output.added.length,
        detail: `${found} of ${output.added.length} items are on the list.`,
      });
    },
  }),

  defineTool({
    name: 'groceries.listOpen',
    aliases: ['get_grocery_list', 'list_grocery_items'],
    description: 'Read what is still to buy, grouped by store aisle.',
    domain: 'shopping',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ list_id: z.string().nullish(), limit: z.number().int().nullish() }),
    output: z.object({ list_id: z.string().nullable(), items: z.array(itemOutput) }),
    summarize: (_input, output) => (output.items.length === 0
      ? 'The shopping list is empty'
      : `${plural(output.items.length, 'item')} still to buy`),
    execute: async (scope, input) => {
      const res = await listOpen(scope, { listId: input.list_id ?? null, limit: input.limit ?? undefined });
      if (!res.ok) return res;
      return ok({
        list_id: res.data.listId,
        items: res.data.items.map((row) => ({
          id: row.id, name: row.name, quantity: row.quantity, category: row.category, is_checked: row.is_checked,
        })),
      });
    },
  }),

  defineTool({
    name: 'groceries.checkItem',
    aliases: ['check_grocery_item', 'mark_grocery_bought'],
    description: 'Tick an item off the shopping list (or put it back).',
    domain: 'shopping',
    capability: 'edit',
    risk: 'low',
    readOnly: false,
    // The service records this one now, with its own copy, so the family sees
    // the same line whether Bubaly did it or a person did. Without this the
    // executor would add a second, blander entry for the assistant's path.
    activityFrom: 'service',
    input: z.object({ item_id: z.string(), checked: z.boolean().nullish().describe('Defaults to true') }),
    output: itemOutput,
    summarize: (_input, output) => (output.is_checked ? `Ticked ${output.name} off the list` : `Put ${output.name} back on the list`),
    resource: (output) => ({ table: 'grocery_items', id: output.id }),
    execute: async (scope, input) => {
      const res = await checkItem(scope, input.item_id, input.checked ?? true);
      if (!res.ok) return res;
      const row = res.data;
      return ok({ id: row.id, name: row.name, quantity: row.quantity, category: row.category, is_checked: row.is_checked });
    },
  }),

  defineTool({
    name: 'groceries.clearChecked',
    aliases: ['clear_checked_items'],
    description: 'Remove everything already in the cart from the shopping list.',
    domain: 'shopping',
    capability: 'delete',
    risk: 'medium',
    readOnly: false,
    // The service records this one now, with its own copy, so the family sees
    // the same line whether Bubaly did it or a person did. Without this the
    // executor would add a second, blander entry for the assistant's path.
    activityFrom: 'service',
    input: z.object({ list_id: z.string() }),
    output: z.object({ removed: z.number() }),
    summarize: (_input, output) => `Cleared ${plural(output.removed, 'bought item')} off the shopping list`,
    consequences: () => ['Deletes the checked-off items from the list; they cannot be restored.'],
    execute: async (scope, input) => {
      const res = await clearChecked(scope, input.list_id);
      if (!res.ok) return res;
      return ok({ removed: res.data.removed });
    },
  }),
];
