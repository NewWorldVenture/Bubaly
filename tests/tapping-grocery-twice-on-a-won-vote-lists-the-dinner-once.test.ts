// Turning a won meal vote into groceries goes through the grocery service, so
// the family's list gets the same rules every other "add a recipe" gets.
//
// `addWinnerToGrocery` (app/(app)/dashboard/recipes/vote/actions.ts) used to
// find-or-create the list and INSERT the winning recipe's ingredients itself:
//
//     const { error: insErr } = await supabase.from('grocery_items').insert(items);
//
// That skipped everything `addItems` in lib/services/groceries enforces, and a
// family could see every piece of it:
//
//   - no duplicate check. The Grocery button stays on a closed vote, so a second
//     tap (or a partner tapping it on their phone) put a second tortillas and a
//     second ground beef on the list, and toasted "Added to grocery list" both
//     times. Adding taco night when tortillas were already listed did the same.
//     Nothing in the schema stops it: grocery_items has no unique name index.
//   - no aisle. Every line was written with category null, and the list sorts
//     categories first with nulls last, so the dinner sat in a heap at the
//     bottom instead of in Bakery and Meat & Seafood.
//   - no household trail entry, so the add never appeared in the family's
//     activity.
//
// What this does NOT cover, on purpose: allergy screening. The claim that this
// action "bypasses the allergy check" is not what the code says. The fail-closed
// dietary read lives only in `addFromMealPlan`; `addItems` screens nothing, and
// the recipe vault's own "add ingredients" button goes through `addItems` and is
// exactly as unscreened. Routing through the service could not add a check that
// the service does not have.
//
// These drive the real action and the real service against the in-memory
// database, then read the list back the way the shopping page would.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { describeGroceryAdd, groceryAddWasNoOp } from '@/lib/groceries/add-summary';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
// The real en-US catalogue, so a refusal is asserted as the sentence a family reads.
const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => MESSAGES[key] ?? key }));

const { addWinnerToGrocery } = await import('@/app/(app)/dashboard/recipes/vote/actions');

const FAMILY = 'family-1';
const LIST = 'list-groceries';
const VOTE = 'vote-taco-night';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

/** The open lines on a list, as the shopping page shows them. */
function openLines(listId = LIST) {
  return db.table('grocery_items').filter((r) => r.list_id === listId && r.is_checked === false);
}
function openNames(listId = LIST) {
  return openLines(listId).map((r) => String(r.name).toLowerCase()).sort();
}

/**
 * The household every case starts from. `maxRows` is PostgREST's db-max-rows,
 * the server's silent per-response ceiling; unset means no cap.
 */
function openHousehold(options: { maxRows?: number } = {}) {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    ...options,
    defaults: {
      grocery_items: { quantity: null, category: null, is_checked: false, source_meal_id: null, idempotency_key: null },
      grocery_lists: { is_archived: false, archived_at: null, store: null, list_icon: null, list_color: null, sort_order: 0 },
    },
  });
  // Taco night won 3-0, it is a saved recipe, and the family already keeps one list.
  db.seed('grocery_lists', [{ id: LIST, family_id: FAMILY, name: 'Groceries', created_by: 'user-1', created_at: '2026-01-01T00:00:00Z' }]);
  db.seed('meal_votes', [{ id: VOTE, family_id: FAMILY, title: 'Friday dinner', status: 'closed', winner_option_id: 'opt-tacos' }]);
  db.seed('meal_vote_options', [{ id: 'opt-tacos', vote_id: VOTE, family_id: FAMILY, recipe_id: 'rec-tacos', label: 'Tacos' }]);
  db.seed('family_recipes', [{
    id: 'rec-tacos', family_id: FAMILY, name: 'Tacos',
    ingredients: [{ name: 'Tortillas', quantity: '8' }, { name: 'Ground beef', quantity: '1', unit: 'lb' }],
  }]);
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: FAMILY, role: 'parent',
      family: { name: 'Family One', timezone: 'America/New_York' },
      member: { id: 'member-1' },
    },
  });
  mocks.createServer.mockResolvedValue(db);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  openHousehold();
});
afterEach(() => vi.restoreAllMocks());

describe('tapping Grocery on a won vote', () => {
  it('puts each ingredient on the list once, however many times it is tapped', async () => {
    const first = await addWinnerToGrocery(VOTE);
    expect(first.ok, first.ok ? '' : first.error).toBe(true);
    expect(openNames()).toEqual(['ground beef', 'tortillas']);

    const second = await addWinnerToGrocery(VOTE);
    expect(second.ok, second.ok ? '' : second.error).toBe(true);
    // The list the family shops from still has one of each, not two.
    expect(openNames()).toEqual(['ground beef', 'tortillas']);
    expect(openLines()).toHaveLength(2);
  });

  it('tells the family a second tap added nothing, rather than "Added" again', async () => {
    await addWinnerToGrocery(VOTE);
    const second = await addWinnerToGrocery(VOTE);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // What vote-client toasts for this result, in the warning tone.
    expect(groceryAddWasNoOp(second)).toBe(true);
    expect(describeGroceryAdd(second)).toBe('All 2 items were already on your list');
  });

  it('does not add a second line for an ingredient already on the list', async () => {
    db.seed('grocery_items', [{ family_id: FAMILY, list_id: LIST, name: 'tortillas', created_by: 'user-2' }]);

    const result = await addWinnerToGrocery(VOTE);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(openNames()).toEqual(['ground beef', 'tortillas']);
    if (result.ok) expect(describeGroceryAdd(result)).toBe('Added 1 item · 1 already on your list');
  });

  it('files the dinner by aisle instead of in an uncategorised heap', async () => {
    await addWinnerToGrocery(VOTE);
    const aisle = Object.fromEntries(openLines().map((r) => [r.name, r.category]));
    expect(aisle).toEqual({ Tortillas: 'Bakery', 'Ground beef': 'Meat & Seafood' });
  });

  it('shows up on the household trail', async () => {
    await addWinnerToGrocery(VOTE);
    const trail = db.table('audit_logs').filter((r) => r.family_id === FAMILY && r.resource === 'groceries');
    expect(trail).toHaveLength(1);
    expect(trail[0]!.actor_id).toBe('user-1');
  });
});

// Negative controls. Without these, a version that refused every add, or that
// treated a line bought last week as still on the list, would pass the cases above.
describe('what tapping Grocery still does', () => {
  it('adds an ingredient again once the last one was bought', async () => {
    db.seed('grocery_items', [{ family_id: FAMILY, list_id: LIST, name: 'Tortillas', is_checked: true, created_by: 'user-1' }]);
    const result = await addWinnerToGrocery(VOTE);
    expect(result.ok && result.added).toBe(2);
    expect(openNames()).toEqual(['ground beef', 'tortillas']);
  });

  it('adds to the oldest live list, skipping an archived one, and creates no other list', async () => {
    db.seed('grocery_lists', [
      { id: 'list-archived', family_id: FAMILY, name: 'Old', created_by: 'user-1', created_at: '2025-01-01T00:00:00Z', archived_at: '2025-06-01T00:00:00Z' },
      { id: 'list-newer', family_id: FAMILY, name: 'Costco', created_by: 'user-1', created_at: '2026-03-01T00:00:00Z' },
    ]);
    const result = await addWinnerToGrocery(VOTE);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(openNames(LIST)).toEqual(['ground beef', 'tortillas']);
    expect(openLines('list-archived')).toEqual([]);
    expect(openLines('list-newer')).toEqual([]);
    expect(db.table('grocery_lists')).toHaveLength(3);
  });

  it('creates exactly one "Groceries" for a family that has no list yet', async () => {
    db.replace('grocery_lists', []);
    const result = await addWinnerToGrocery(VOTE);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    const lists = db.table('grocery_lists').filter((r) => r.family_id === FAMILY);
    expect(lists.map((l) => l.name)).toEqual(['Groceries']);
    expect(openNames(String(lists[0]!.id))).toEqual(['ground beef', 'tortillas']);
  });

  it('still refuses to add a winner that is not a saved recipe', async () => {
    db.table('meal_vote_options')[0]!.recipe_id = null;
    const result = await addWinnerToGrocery(VOTE);
    expect(result.ok === false && result.error).toBe('The winning option is not a saved recipe.');
    expect(db.table('grocery_items')).toEqual([]);
  });
});

describe('a recipe whose ingredients are not all in one shape', () => {
  // `family_recipes.ingredients` is untyped jsonb with several writers. The
  // service refuses the WHOLE add when any one item has a non-string name, so a
  // cast that handed it `name: undefined` for a bare-string entry cost the family
  // every other ingredient in the dinner, with a refusal about "the items".
  it('adds a bare-string ingredient and a `qty` one, and skips a nameless entry', async () => {
    db.table('family_recipes')[0]!.ingredients = ['Tortillas', { name: 'Ground beef', qty: 1, unit: 'lb' }, { quantity: '2' }];
    const result = await addWinnerToGrocery(VOTE);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(result.ok && result.added).toBe(2);
    expect(Object.fromEntries(openLines().map((r) => [r.name, r.quantity]))).toEqual({ Tortillas: null, 'Ground beef': '1 lb' });
  });

  it('still says the recipe has no ingredients when none of its entries names one', async () => {
    db.table('family_recipes')[0]!.ingredients = [{ quantity: '2' }, '   '];
    const result = await addWinnerToGrocery(VOTE);
    expect(result.ok === false && result.error).toBe('That recipe has no ingredients.');
    expect(db.table('grocery_items')).toEqual([]);
  });
});

describe('when the add cannot be confirmed', () => {
  // The service writes the rows and then reads them back. When that read comes
  // back short (here: PostgREST's db-max-rows capping every response at one row,
  // silently, the way the real server does) the rows ARE on the list and the
  // service says exactly that. Replacing its sentence with "Could not add those
  // items." told the family the opposite of what happened.
  it('passes on the service\'s "could not confirm", not "could not add"', async () => {
    openHousehold({ maxRows: 1 });
    const result = await addWinnerToGrocery(VOTE);
    expect(openNames(), 'both rows were written').toEqual(['ground beef', 'tortillas']);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('Could not confirm the added items. Refresh the list before trying again.');
    expect(result.ok === false && result.error).not.toBe(MESSAGES['actions.couldNotAddThoseItems']);
  });
});
