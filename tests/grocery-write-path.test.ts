// "A parent typing 'Milk' into the grocery list when milk is already on it gets
// a second Milk line; Bubaly adding milk skips it." — §7, second symptom.
//
// The mechanism is NOT the calendar's. There is no idempotency key here: the
// service deduplicates on the NORMALISED NAME against the list's open items, so
// "Milk", "milk" and "milks" are one thing, and an item already bought is not
// part of the comparison. Driving the real service against an in-memory Postgres
// is what makes that a property rather than a claim about a mock.
//
// The other half these cases hold is the ARCHIVE DIVERGENCE. `grocery_lists`
// carries two columns that answer "is this archived": `is_archived` from 0002
// and `archived_at` from 0014. Nothing in the application ever sets
// `is_archived` — the only archive writer is the shopping module, which stamps
// `archived_at` — so every `is_archived`-only reader, the service included,
// went on treating a family's archived list as their open one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import {
  addGroceryItemsAction, clearCheckedGroceriesAction, removeGroceryItemAction, setGroceryItemCheckedAction,
} from '@/app/(app)/dashboard/grocery/actions';
import { describeGroceryAdd, groceryAddWasNoOp } from '@/lib/groceries/add-summary';

const FAMILY = 'family-1';
const LIST = 'list-1';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

function itemsOn(listId = LIST) {
  return db.table('grocery_items').filter((r) => r.list_id === listId);
}
function names(listId = LIST) {
  return itemsOn(listId).map((r) => r.name);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      grocery_items: { quantity: null, category: null, is_checked: false, source_meal_id: null, idempotency_key: null },
      grocery_lists: { is_archived: false, archived_at: null, store: null, list_icon: null, list_color: null, sort_order: 0 },
    },
  });
  db.seed('grocery_lists', [{ id: LIST, family_id: FAMILY, name: 'Groceries', created_by: 'user-1' }]);
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: FAMILY, role: 'parent',
      family: { name: 'Family One', timezone: 'America/New_York' },
      member: { id: 'member-1' },
    },
  });
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

describe('typing something that is already on the list', () => {
  beforeEach(() => {
    db.seed('grocery_items', [{ family_id: FAMILY, list_id: LIST, name: 'Milk', created_by: 'user-1' }]);
  });

  it.each(['Milk', 'milk', 'MILK', '  milk  ', 'milks'])('skips %j rather than adding a second line', async (typed) => {
    // `normalizeName` lowercases, collapses whitespace and drops ONE trailing 's',
    // so all five of these are the milk already on the list.
    const result = await addGroceryItemsAction({ items: [{ name: typed }], listId: LIST });

    expect(result.ok).toBe(true);
    expect(result.ok && result.added).toBe(0);
    // Trimmed, because the service trims before comparing — so the toast reads
    // "milk is already on your list", not "  milk   is already on your list".
    expect(result.ok && result.skipped).toEqual([typed.trim()]);
    expect(names()).toEqual(['Milk']);
  });

  it('adds something genuinely new alongside it', async () => {
    const result = await addGroceryItemsAction({ items: [{ name: 'Bread' }], listId: LIST });
    expect(result.ok && result.added).toBe(1);
    expect(names()).toEqual(['Milk', 'Bread']);
  });

  it('adds it again once the first one has been bought', async () => {
    // Deduplication is against OPEN items only. Milk bought last week should be
    // addable again; milk still on the list should not.
    db.table('grocery_items')[0]!.is_checked = true;
    const result = await addGroceryItemsAction({ items: [{ name: 'milk' }], listId: LIST });
    expect(result.ok && result.added).toBe(1);
    expect(names()).toEqual(['Milk', 'milk']);
  });

  it('does not confuse another family’s milk for this one', async () => {
    db.seed('grocery_lists', [{ id: 'other-list', family_id: 'family-2', name: 'Groceries' }]);
    db.seed('grocery_items', [{ family_id: 'family-2', list_id: 'other-list', name: 'Bread' }]);

    const result = await addGroceryItemsAction({ items: [{ name: 'Bread' }], listId: LIST });
    expect(result.ok && result.added).toBe(1);
    expect(names()).toEqual(['Milk', 'Bread']);
    expect(names('other-list')).toEqual(['Bread']);
  });
});

describe('adding a recipe or a restock in one go', () => {
  beforeEach(() => {
    db.seed('grocery_items', [
      { family_id: FAMILY, list_id: LIST, name: 'Milk', created_by: 'user-1' },
      { family_id: FAMILY, list_id: LIST, name: 'Onions', created_by: 'user-1' },
    ]);
  });

  it('adds only what is missing and reports what it skipped', async () => {
    // Taco night: the staples are already there, the tortillas are not.
    const result = await addGroceryItemsAction({
      items: [{ name: 'Milk' }, { name: 'onion' }, { name: 'Tortillas' }, { name: 'Ground beef' }],
      listId: LIST,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.added).toBe(2);
    expect(result.skipped).toEqual(['Milk', 'onion']);
    expect(names()).toEqual(['Milk', 'Onions', 'Tortillas', 'Ground beef']);
  });

  it('deduplicates within the batch itself', async () => {
    // Two recipes in one add, both wanting eggs.
    const result = await addGroceryItemsAction({ items: [{ name: 'Eggs' }, { name: 'eggs' }], listId: LIST });
    expect(result.ok && result.added).toBe(1);
    expect(names().filter((n) => String(n).toLowerCase().startsWith('egg'))).toEqual(['Eggs']);
  });
});

describe('the family is told which of the two happened', () => {
  it('names the item when the only thing added was already there', () => {
    // The failure this replaces is silent: a raw insert always "succeeded", so a
    // parent typing Milk saw a cheerful confirmation and a second Milk line.
    expect(describeGroceryAdd({ added: 0, skipped: ['Milk'] })).toBe('Milk is already on your list');
    expect(groceryAddWasNoOp({ added: 0, skipped: ['Milk'] })).toBe(true);
  });

  it('counts them when a whole batch was already there', () => {
    expect(describeGroceryAdd({ added: 0, skipped: ['Milk', 'Eggs'] })).toBe('All 2 items were already on your list');
  });

  it('reports both halves of a partial add', () => {
    expect(describeGroceryAdd({ added: 2, skipped: ['Milk'] })).toBe('Added 2 items · 1 already on your list');
    expect(groceryAddWasNoOp({ added: 2, skipped: ['Milk'] })).toBe(false);
  });

  it('stays plain when nothing was skipped', () => {
    expect(describeGroceryAdd({ added: 1, skipped: [] })).toBe('Added 1 item to your grocery list');
    expect(describeGroceryAdd({ added: 3, skipped: [] })).toBe('Added 3 items to your grocery list');
  });
});

describe('a list the family archived', () => {
  it('is not treated as their open list, however it was archived', async () => {
    // The bug: the shopping module archives by stamping `archived_at` and NOTHING
    // sets `is_archived`, so a service reading only `is_archived` kept adding to
    // a list the family had archived and could no longer see.
    db.table('grocery_lists')[0]!.archived_at = '2026-09-01T00:00:00.000Z';

    const result = await addGroceryItemsAction({ items: [{ name: 'Milk' }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listId, 'a fresh list, not the archived one').not.toBe(LIST);
    expect(itemsOn(LIST), 'nothing lands on the archived list').toHaveLength(0);
    expect(names(result.listId)).toEqual(['Milk']);
  });

  it('is not treated as open when archived the other way either', async () => {
    db.table('grocery_lists')[0]!.is_archived = true;
    const result = await addGroceryItemsAction({ items: [{ name: 'Milk' }] });
    expect(result.ok && result.listId).not.toBe(LIST);
  });

  it('is still written to when the caller names it explicitly', async () => {
    // An explicit list id is the surface saying which list it is showing, and the
    // shopping module only ever shows an open one. Overriding that would be the
    // service second-guessing its caller.
    db.table('grocery_lists')[0]!.archived_at = '2026-09-01T00:00:00.000Z';
    const result = await addGroceryItemsAction({ items: [{ name: 'Milk' }], listId: LIST });
    expect(result.ok && result.listId).toBe(LIST);
  });
});

describe('what the server stores', () => {
  it('takes family_id and created_by from the session, and files by aisle', async () => {
    await addGroceryItemsAction({ items: [{ name: 'Chicken thighs' }], listId: LIST });
    const row = itemsOn()[0]!;
    expect(row.family_id).toBe(FAMILY);
    // grocery_items.created_by references auth.users (0002).
    expect(row.created_by).toBe('user-1');
    // Uncategorised input gets an aisle, so the list can be walked in one pass.
    expect(row.category).toBe('Meat & Seafood');
  });

  it('keeps a category the surface chose', async () => {
    await addGroceryItemsAction({ items: [{ name: 'Chicken thighs', category: 'Pantry' }], listId: LIST });
    expect(itemsOn()[0]!.category).toBe('Pantry');
  });

  it('refuses an empty add rather than creating a list for nothing', async () => {
    const result = await addGroceryItemsAction({ items: [] });
    expect(result.ok).toBe(false);
    expect(db.table('grocery_lists')).toHaveLength(1);
  });

  it('drops blank names instead of writing them', async () => {
    const result = await addGroceryItemsAction({ items: [{ name: '   ' }, { name: 'Bread' }], listId: LIST });
    expect(result.ok && result.added).toBe(1);
    expect(names()).toEqual(['Bread']);
  });
});

describe('a caller who is not signed in', () => {
  it('is redirected, not handed an error toast', async () => {
    mocks.requireUserContext.mockRejectedValueOnce(
      Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' }),
    );
    await expect(addGroceryItemsAction({ items: [{ name: 'Milk' }] })).rejects.toThrow('NEXT_REDIRECT');
    expect(itemsOn()).toHaveLength(0);
  });
});

describe('ticking off, removing, and clearing the cart', () => {
  beforeEach(() => {
    db.seed('grocery_items', [
      { id: 'milk', family_id: FAMILY, list_id: LIST, name: 'Milk', is_checked: false },
      { id: 'eggs', family_id: FAMILY, list_id: LIST, name: 'Eggs', is_checked: true },
      { id: 'theirs', family_id: 'family-2', list_id: 'other-list', name: 'Bread', is_checked: true },
    ]);
  });

  it('ticks an item off and puts it back', async () => {
    expect((await setGroceryItemCheckedAction('milk', true)).ok).toBe(true);
    expect(db.table('grocery_items').find((r) => r.id === 'milk')!.is_checked).toBe(true);

    expect((await setGroceryItemCheckedAction('milk', false)).ok).toBe(true);
    expect(db.table('grocery_items').find((r) => r.id === 'milk')!.is_checked).toBe(false);
  });

  it('removes one item', async () => {
    expect((await removeGroceryItemAction('milk')).ok).toBe(true);
    expect(names()).toEqual(['Eggs']);
  });

  it('clears what is checked ON THE LIST, not what a stale render held', async () => {
    // The client sent `.in('id', checkedIds)` from its last render, so an item a
    // partner ticked on another phone between render and tap survived the clear.
    // Standing in for that partner: milk becomes checked after the page rendered.
    db.table('grocery_items').find((r) => r.id === 'milk')!.is_checked = true;

    const result = await clearCheckedGroceriesAction(LIST);
    expect(result.ok && result.removed).toBe(2);
    expect(itemsOn()).toHaveLength(0);
  });

  it('leaves the unchecked alone', async () => {
    const result = await clearCheckedGroceriesAction(LIST);
    expect(result.ok && result.removed).toBe(1);
    expect(names()).toEqual(['Milk']);
  });

  it('cannot tick off or remove another household’s item', async () => {
    expect((await setGroceryItemCheckedAction('theirs', false)).ok).toBe(false);
    expect((await removeGroceryItemAction('theirs')).ok).toBe(false);
    // Both survive, unchanged: the client filtered `id` alone.
    const theirs = db.table('grocery_items').find((r) => r.id === 'theirs')!;
    expect(theirs.is_checked).toBe(true);
  });

  it('cannot clear another household’s list', async () => {
    const result = await clearCheckedGroceriesAction('other-list');
    expect(result.ok && result.removed).toBe(0);
    expect(db.table('grocery_items').some((r) => r.id === 'theirs')).toBe(true);
  });
});
