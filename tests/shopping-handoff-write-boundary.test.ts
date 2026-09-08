// The two ends of M10's loop, driven through the real server actions against an
// in-memory Postgres.
//
// The audit's finding was that the loop's maths existed and its middle did not:
// `addFromMealPlan` and `pantryAdjust` were both real and both tested, and
// nothing a person could tap reached either. These cases pin the middle, and in
// particular the three claims a family could be lied to about:
//
//   * "Bought" ADDS THE QUANTITY to the pantry — the whole point, since a
//     pantry that never hears about the shop buys the milk again next week;
//   * a purchase is recorded ONLY when someone typed an amount, and
//     `purchaseRecorded` is read from the row that exists, never assumed;
//   * a pantry failure leaves the list UNTOUCHED, so the retry does the same
//     thing again rather than something new.
//
// The retailer hand-off is asserted at the same boundary it is built from: the
// links come from what is still to buy, and a ticked-off item is not in them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import {
  addMealPlanToGroceryListAction, recordShoppingTripAction,
} from '@/app/(app)/dashboard/grocery/actions';
import { parsePurchasedQuantity } from '@/lib/services/groceries';
import { buildShoppingText, itemSearchUrl, RETAILERS } from '@/lib/grocery/retailers';

const FAMILY = 'family-1';
const LIST = 'list-1';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let errorLog: ReturnType<typeof vi.spyOn>;

function pantry() {
  return db.table('pantry_items').filter((r) => r.family_id === FAMILY);
}
function pantryFor(name: string) {
  return pantry().find((r) => String(r.name).toLowerCase() === name.toLowerCase());
}
function itemsOn() {
  return db.table('grocery_items').filter((r) => r.list_id === LIST);
}

function signIn(role: 'parent' | 'child' = 'parent') {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: FAMILY, role,
      family: { name: 'Family One', timezone: 'America/New_York' },
      member: { id: 'member-1' },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      grocery_items: { quantity: null, category: null, is_checked: false, source_meal_id: null, idempotency_key: null },
      grocery_lists: { is_archived: false, archived_at: null, store: null, list_icon: null, list_color: null, sort_order: 0 },
      pantry_items: { quantity: 1, unit: null, location: 'pantry', expires_at: null, category: null, low_threshold: null, is_staple: false, notes: null },
      transactions: { type: 'expense', merchant: null, category: null, notes: null, account_id: null, member_id: null, receipt_document_id: null, source: 'manual' },
    },
  });
  db.seed('grocery_lists', [{ id: LIST, family_id: FAMILY, name: 'Groceries', created_by: 'user-1' }]);
  signIn();
  mocks.createServer.mockResolvedValue(db);
});

afterEach(() => { errorLog.mockRestore(); });

describe('Bought → pantry', () => {
  beforeEach(() => {
    db.seed('grocery_items', [
      { id: 'i-1', family_id: FAMILY, list_id: LIST, name: 'Milk', quantity: '2 gal', is_checked: true },
      { id: 'i-2', family_id: FAMILY, list_id: LIST, name: 'Rice', quantity: null, is_checked: true },
      { id: 'i-3', family_id: FAMILY, list_id: LIST, name: 'Apples', quantity: '6', is_checked: false },
    ]);
  });

  it('adds the quantity of every bought line to the pantry and clears them from the list', async () => {
    db.seed('pantry_items', [{ id: 'p-1', family_id: FAMILY, name: 'Milk', quantity: 1 }]);

    const result = await recordShoppingTripAction({ listId: LIST });
    expect(result).toMatchObject({ ok: true, purchaseRecorded: false });
    if (!result.ok) throw new Error(result.error);

    expect(result.pantryUpdated).toEqual(['Milk', 'Rice']);
    expect(result.pantryFailed).toEqual([]);
    expect(result.cleared).toBe(2);

    // The existing row is INCREMENTED by what the list said, not overwritten.
    expect(pantryFor('Milk')).toMatchObject({ quantity: 3 });
    // Something the family has never had before is created at the bought amount.
    expect(pantryFor('Rice')).toMatchObject({ quantity: 1, family_id: FAMILY });

    // Only the bought lines left the list; the unbought one stayed.
    expect(itemsOn().map((r) => r.name)).toEqual(['Apples']);
  });

  it('records NO purchase when no amount was typed', async () => {
    const result = await recordShoppingTripAction({ listId: LIST });
    expect(result).toMatchObject({ ok: true, purchaseRecorded: false });
    expect(db.table('transactions')).toHaveLength(0);
  });

  it('records the purchase, once, when an amount is given', async () => {
    const result = await recordShoppingTripAction({ listId: LIST, amount: 84.25, merchant: 'Kroger' });
    expect(result).toMatchObject({ ok: true, purchaseRecorded: true });
    if (!result.ok) throw new Error(result.error);
    expect(result.purchaseError).toBeUndefined();

    const rows = db.table('transactions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      family_id: FAMILY, amount: 84.25, type: 'expense', category: 'Groceries', merchant: 'Kroger', source: 'manual',
    });
  });

  it('a zero or blank amount is "no receipt", not a free shop', async () => {
    const zero = await recordShoppingTripAction({ listId: LIST, amount: 0 });
    expect(zero).toMatchObject({ ok: true, purchaseRecorded: false });
    expect(db.table('transactions')).toHaveLength(0);
  });

  it('says the purchase did not land rather than claiming it did, and still stocks the pantry', async () => {
    // A child may tick a list off; recording a charge on the household books is
    // a manager's write, and the finances service refuses it.
    signIn('child');
    const result = await recordShoppingTripAction({ listId: LIST, amount: 40 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.purchaseRecorded).toBe(false);
    expect(result.purchaseError).toMatch(/parent|adult/i);
    expect(db.table('transactions')).toHaveLength(0);
    // The pantry half still happened, and the result says so.
    expect(result.pantryUpdated).toEqual(['Milk', 'Rice']);
  });

  it('refuses a shop with nothing ticked off, rather than pretending', async () => {
    db.replace('grocery_items', itemsOn().map((r) => ({ ...r, is_checked: false })));
    const result = await recordShoppingTripAction({ listId: LIST });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error).toMatch(/tick off/i);
    expect(db.table('pantry_items')).toHaveLength(0);
  });

  it('needs a list', async () => {
    const result = await recordShoppingTripAction({ listId: '' });
    expect(result.ok).toBe(false);
  });
});

describe('a failed pantry write leaves the list alone', () => {
  it('reports the names that failed, clears nothing and records no purchase', async () => {
    db.seed('grocery_items', [
      { id: 'i-1', family_id: FAMILY, list_id: LIST, name: 'Milk', quantity: '1', is_checked: true },
    ]);
    // The pantry insert fails the way a constraint violation or an outage does.
    const realFrom = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const builder = realFrom(table);
      if (table !== 'pantry_items') return builder;
      const failing = builder as unknown as Record<string, unknown>;
      failing.insert = () => ({
        select: () => ({
          single: async () => ({ data: null, error: { code: '23505', message: 'pantry is full', details: null, hint: null } }),
          maybeSingle: async () => ({ data: null, error: { code: '23505', message: 'pantry is full', details: null, hint: null } }),
        }),
      });
      return builder;
    }) as typeof db.from);

    const result = await recordShoppingTripAction({ listId: LIST, amount: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.pantryUpdated).toEqual([]);
    expect(result.pantryFailed.map((f) => f.name)).toEqual(['Milk']);
    expect(result.cleared).toBe(0);
    // No purchase either: the shop did not complete, so nothing is claimed.
    expect(result.purchaseRecorded).toBe(false);
    expect(db.table('transactions')).toHaveLength(0);
    // And the list is exactly as the family left it, so the retry is the same act.
    expect(itemsOn().map((r) => r.name)).toEqual(['Milk']);
    expect(errorLog).toHaveBeenCalled();
  });
});

describe('parsePurchasedQuantity', () => {
  it('reads the leading amount and its unit', () => {
    expect(parsePurchasedQuantity('2 lb')).toEqual({ delta: 2, unit: 'lb' });
    expect(parsePurchasedQuantity('2.5kg')).toEqual({ delta: 2.5, unit: 'kg' });
    expect(parsePurchasedQuantity('3')).toEqual({ delta: 3, unit: null });
    expect(parsePurchasedQuantity('1/2 cup')).toEqual({ delta: 0.5, unit: 'cup' });
  });

  it('a line with no number is one of the thing', () => {
    expect(parsePurchasedQuantity(null)).toEqual({ delta: 1, unit: null });
    expect(parsePurchasedQuantity('')).toEqual({ delta: 1, unit: null });
    expect(parsePurchasedQuantity('a bunch')).toEqual({ delta: 1, unit: null });
  });

  it('takes the FIRST amount of a merged line rather than inventing a sum', () => {
    // `planGroceryNeeds` writes "2 lb + 1 cup" when two dishes want the same
    // thing in different units; three of something would be fiction.
    expect(parsePurchasedQuantity('2 lb + 1 cup')).toEqual({ delta: 2, unit: 'lb' });
  });
});

describe('the retailer hand-off is built from what is still to buy', () => {
  const open = [
    { name: 'Apples', quantity: '6' },
    { name: 'Olive oil', quantity: null },
  ];

  it('the copy-paste list carries the unbought lines and their quantities', () => {
    expect(buildShoppingText(open)).toBe('6 Apples\nOlive oil');
  });

  it('a bought line is not in the copied list', () => {
    const items = [
      { name: 'Apples', quantity: '6', is_checked: false },
      { name: 'Milk', quantity: '1 gal', is_checked: true },
    ];
    const text = buildShoppingText(items.filter((i) => !i.is_checked).map((i) => ({ name: i.name, quantity: i.quantity })));
    expect(text).toBe('6 Apples');
    expect(text).not.toContain('Milk');
  });

  it('every chip deep-links into that store’s own search, with no affiliate or referral parameter', () => {
    for (const retailer of RETAILERS) {
      const url = itemSearchUrl(retailer.id, 'olive oil');
      expect(url).toMatch(/^https:\/\//);
      expect(url).toContain('olive+oil');
      // Nothing that would make a link paid: no affiliate tag, no referral, no
      // click-tracking id. If a paid relationship ever exists it must be
      // disclosed on the surface, and this case has to be changed to say so.
      expect(url).not.toMatch(/\b(?:aff|affiliate|tag=|ref=|referral|utm_|clickid|irgwc|subid)\b/i);
    }
  });

  it('an unknown retailer produces a dead link rather than a wrong store', () => {
    expect(itemSearchUrl('not-a-store', 'milk')).toBe('#');
  });
});

describe('Add this week to the list', () => {
  beforeEach(() => {
    db.seed('meals', [
      {
        id: 'm-1', family_id: FAMILY, name: 'Peanut noodles', meal_type: 'dinner',
        ingredients: ['peanut butter', 'jasmine rice', 'Apples'],
      },
    ]);
    db.seed('meal_plans', [
      { id: 'mp-1', family_id: FAMILY, meal_id: 'm-1', plan_date: '2026-09-08', meal_type: 'dinner', created_by: 'user-1' },
    ]);
  });

  it('writes the delta, and reports what it skipped rather than swallowing it', async () => {
    db.seed('grocery_items', [
      { id: 'i-1', family_id: FAMILY, list_id: LIST, name: 'Apples', is_checked: false },
    ]);

    const result = await addMealPlanToGroceryListAction({ from: '2026-09-08', to: '2026-09-08', listId: LIST });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    expect(result.skipped).toEqual(['Apples']);
    expect(itemsOn().map((r) => r.name)).toContain('peanut butter');
    expect(result.meals.map((m) => m.name)).toEqual(['Peanut noodles']);
  });

  it('applies the household’s allergies to what it writes, and says why', async () => {
    db.seed('medical_profiles', [
      { id: 'md-1', family_id: FAMILY, member_id: 'member-1', allergies: 'Peanuts' },
    ]);

    const result = await addMealPlanToGroceryListAction({ from: '2026-09-08', to: '2026-09-08', listId: LIST });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const written = itemsOn().map((r) => r.name);
    expect(written).toContain('sunflower seed butter');
    expect(written).not.toContain('peanut butter');

    const swap = result.substitutions.find((s) => s.from === 'peanut butter');
    expect(swap).toMatchObject({ to: 'sunflower seed butter', kind: 'allergy', reasonKey: 'allergySwap' });
    expect(swap?.reason).toBeTruthy();
  });

  it('prefers what the pantry already holds over a near-identical purchase', async () => {
    db.seed('pantry_items', [{ id: 'p-1', family_id: FAMILY, name: 'brown rice', quantity: 2 }]);

    const result = await addMealPlanToGroceryListAction({ from: '2026-09-08', to: '2026-09-08', listId: LIST });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    expect(itemsOn().map((r) => r.name)).not.toContain('jasmine rice');
    expect(result.substitutions.find((s) => s.from === 'jasmine rice')).toMatchObject({
      to: 'brown rice', kind: 'pantry', reasonKey: 'pantrySwap',
    });
  });

  it('FAILS CLOSED when the allergy read errors, rather than shopping blind', async () => {
    const realFrom = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table !== 'medical_profiles') return realFrom(table);
      const reply = { data: null, error: { code: '42501', message: 'permission denied', details: null, hint: null } };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain, eq: chain, in: chain, order: chain, limit: chain,
        then: (resolve: (v: unknown) => void) => resolve(reply),
      });
      return builder;
    }) as typeof db.from);

    const result = await addMealPlanToGroceryListAction({ from: '2026-09-08', to: '2026-09-08', listId: LIST });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error).toBeTruthy();
    // Nothing was written: a list built without knowing the allergies is worse
    // than no list.
    expect(itemsOn()).toHaveLength(0);
    expect(errorLog).toHaveBeenCalledWith('[service:groceries] dietary constraint read failed', expect.anything());
  });

  it('says so when the week has no plan, instead of an empty success', async () => {
    const result = await addMealPlanToGroceryListAction({ from: '2026-10-01', to: '2026-10-07', listId: LIST });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error).toMatch(/no meals planned/i);
  });
});
