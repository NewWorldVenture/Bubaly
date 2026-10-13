// The chat toolbox's `add_grocery_item` (lib/assistant/tools.ts) inserted into
// `grocery_items` itself. `mergeToolSets` puts the toolbox ahead of the
// registry's `groceries.addItems`, and /api/ai/chat offers only the toolbox,
// so the grocery service's duplicate check never ran on this path: "add milk"
// with milk still unticked on the list, or the same tool call made twice, gave
// the family two Milk lines. The line also landed with no aisle and left no
// trail entry. The tool now adds through `addItems`, and says so when the item
// was already there.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAssistantTools, type AssistantCtx } from '@/lib/assistant/tools';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

type DbArg = Parameters<typeof buildAssistantTools>[0];

const FAMILY = 'fam-1';
const LIST = 'list-1';
let db: InMemorySupabase;

const ctx = (role: string | null): AssistantCtx => ({
  familyId: FAMILY, userId: 'auth-user-1', memberId: 'member-1', role, members: [], tz: 'UTC',
});

async function addGrocery(args: Record<string, unknown>, role: string | null = 'parent') {
  const tool = buildAssistantTools(db as unknown as DbArg, ctx(role)).find((t) => t.name === 'add_grocery_item');
  if (!tool) throw new Error('add_grocery_item is not in the assistant toolbox');
  return tool.execute(args);
}

const openItems = () => db.table('grocery_items').filter((row) => row.is_checked === false);

beforeEach(() => {
  db = createInMemorySupabase({
    defaults: { grocery_items: { is_checked: false, category: null, quantity: null, source_meal_id: null } },
    rpc: { ensure_default_grocery_list: () => LIST },
  });
  db.seed('grocery_lists', [{ id: LIST, family_id: FAMILY, name: 'Groceries', is_archived: false, archived_at: null }]);
  db.seed('grocery_items', [{ id: 'milk', family_id: FAMILY, list_id: LIST, name: 'Milk', quantity: null, category: 'dairy', is_checked: false, created_by: 'auth-user-1' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('assistant add_grocery_item', () => {
  it('does not add milk that is still on the list, and says it is there', async () => {
    const res = await addGrocery({ item: 'milk' });
    expect(res).toEqual({ ok: true, summary: 'milk is already on the grocery list.' });
    expect(db.table('grocery_items')).toHaveLength(1);
  });

  it('adds an item once when the same call is made twice', async () => {
    expect(await addGrocery({ item: 'Eggs', quantity: '12' })).toEqual({ ok: true, summary: 'Added Eggs to the grocery list.' });
    expect(await addGrocery({ item: 'eggs' })).toMatchObject({ ok: true });
    const eggs = openItems().filter((row) => String(row.name).toLowerCase() === 'eggs');
    expect(eggs).toHaveLength(1);
    expect(eggs[0]).toMatchObject({ family_id: FAMILY, list_id: LIST, name: 'Eggs', quantity: '12', created_by: 'auth-user-1' });
    // Through the service: an aisle is guessed, and the add is on the family's trail.
    expect(eggs[0].category).toEqual(expect.any(String));
    expect(db.table('agent_activity')).toEqual([expect.objectContaining({ family_id: FAMILY, title: 'Added Eggs to the shopping list' })]);
  });

  it('adds milk again once the last carton was ticked off', async () => {
    db.replace('grocery_items', [{ id: 'milk', family_id: FAMILY, list_id: LIST, name: 'Milk', quantity: null, category: 'dairy', is_checked: true, created_by: 'auth-user-1' }]);
    expect(await addGrocery({ item: 'Milk' })).toEqual({ ok: true, summary: 'Added Milk to the grocery list.' });
    expect(openItems()).toEqual([expect.objectContaining({ name: 'Milk', list_id: LIST })]);
  });

  it('refuses a caller whose role it does not know, and writes nothing', async () => {
    expect(await addGrocery({ item: 'Bread' }, null)).toMatchObject({ ok: false });
    expect(await addGrocery({ item: 'Bread' }, 'stranger')).toMatchObject({ ok: false });
    expect(db.table('grocery_items')).toHaveLength(1);
  });

  it('reports a write the database refused as a failure, in the tool\'s own words', async () => {
    const realFrom = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const builder = realFrom(table) as unknown as Record<string, unknown>;
      if (table === 'grocery_items') {
        const insert = builder.insert as (...args: unknown[]) => unknown;
        builder.insert = (...args: unknown[]) => {
          insert.apply(builder, args);
          builder.then = (resolve: (value: unknown) => void) => resolve({ data: null, error: { code: '42501', message: 'permission denied' } });
          return builder;
        };
      }
      return builder;
    }) as unknown as typeof db.from);
    expect(await addGrocery({ item: 'Bread' })).toEqual({ ok: false, error: 'Could not add the grocery item.' });
  });

  it('keeps the item-required answer', async () => {
    expect(await addGrocery({ item: '  ' })).toEqual({ ok: false, error: 'item is required' });
  });
});
