// "We bought these" puts each line away on the pantry row it belongs to, and
// never adds kilograms to cups.
//
// S9 — pantryAdjust found a pantry row by `ilike('%<line name>%')` and only
//   then compared normalised names, so a plural line ("Onions") never fetched
//   the singular row ("Onion") the list and the pantry treat as the same item.
//   A second "Onions" row was created beside it; "Onion" stayed at 0 and on
//   "Running low".
// S12 — a bought line's amount was added to the row's number whatever the two
//   units were, and the row was relabelled with the line's unit: "Rice 3 kg"
//   plus a bought "1 cup" became "Rice 4 cup".
//
// The real server action and service, against an in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { recordShoppingTripAction } from '@/app/(app)/dashboard/grocery/actions';

const FAMILY = 'family-1';
const LIST = 'list-1';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

const pantry = () => db.table('pantry_items').filter((row) => row.family_id === FAMILY)
  .map((row) => ({ name: row.name, quantity: row.quantity, unit: row.unit }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<SupabaseClient<Database>>({ defaults: {
    grocery_items: { quantity: null, category: null, is_checked: false, source_meal_id: null, idempotency_key: null },
    grocery_lists: { is_archived: false, archived_at: null },
    pantry_items: { quantity: 1, unit: null, location: 'pantry', expires_at: null, category: null, low_threshold: null, is_staple: false, notes: null },
  } });
  db.seed('grocery_lists', [{ id: LIST, family_id: FAMILY, name: 'Groceries', created_by: 'user-1' }]);
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: { familyId: FAMILY, role: 'parent', family: { name: 'Family One', timezone: 'America/New_York' }, member: { id: 'member-1' } },
  });
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

const bought = (name: string, quantity: string | null) =>
  db.seed('grocery_items', [{ id: `i-${name}`, family_id: FAMILY, list_id: LIST, name, quantity, is_checked: true }]);

describe('S9: a plural line tops up the singular row', () => {
  it('"Onions 3" is put away on "Onion", not beside it', async () => {
    db.seed('pantry_items', [{ id: 'p-onion', family_id: FAMILY, name: 'Onion', quantity: 0, is_staple: true }]);
    bought('Onions', '3');

    const result = await recordShoppingTripAction({ listId: LIST });

    expect(result).toMatchObject({ ok: true, pantryUpdated: ['Onions'] });
    expect(pantry()).toEqual([{ name: 'Onion', quantity: 3, unit: null }]);
  });

  it('a name with doubled spaces in the pantry is still the same item', async () => {
    db.seed('pantry_items', [{ id: 'p-red', family_id: FAMILY, name: 'Red  onion', quantity: 1 }]);
    bought('Red onions', '2');

    await recordShoppingTripAction({ listId: LIST });

    expect(pantry()).toEqual([{ name: 'Red  onion', quantity: 3, unit: null }]);
  });

  it('the exact row is found however many look like it', async () => {
    db.seed('pantry_items', Array.from({ length: 30 }, (_, i) => ({ id: `p-egg-${i}`, family_id: FAMILY, name: `Egg noodles ${i}`, quantity: 1 })));
    db.seed('pantry_items', [{ id: 'p-egg', family_id: FAMILY, name: 'Egg', quantity: 2 }]);
    bought('Egg', '12');

    await recordShoppingTripAction({ listId: LIST });

    expect(db.table('pantry_items').find((row) => row.id === 'p-egg')?.quantity).toBe(14);
    expect(db.table('pantry_items')).toHaveLength(31);
  });
});

describe('S12: a bought amount is never added across units', () => {
  it('"1 cup" of rice against "3 kg" leaves the pantry row as it was and says so', async () => {
    db.seed('pantry_items', [{ id: 'p-rice', family_id: FAMILY, name: 'Rice', quantity: 3, unit: 'kg' }]);
    bought('Rice', '1 cup');

    const result = await recordShoppingTripAction({ listId: LIST });

    expect(result).toMatchObject({ ok: true, pantryUpdated: [], unitMismatch: [{ name: 'Rice', bought: 'cup', stocked: 'kg' }] });
    expect(pantry()).toEqual([{ name: 'Rice', quantity: 3, unit: 'kg' }]);
    // It was bought: the line is off the list, and a second tap cannot count it.
    expect(db.table('grocery_items')).toEqual([]);
  });

  it('the same unit, however it is spelled, still adds', async () => {
    db.seed('pantry_items', [{ id: 'p-flour', family_id: FAMILY, name: 'Flour', quantity: 2, unit: 'kg' }]);
    bought('Flour', '1 KGs');

    await recordShoppingTripAction({ listId: LIST });

    expect(pantry()).toEqual([{ name: 'Flour', quantity: 3, unit: 'kg' }]);
  });

  it.each([
    ['Cereal', 'box', '2 boxes', 3],
    ['Bananas', 'bunch', '1 bunches', 2],
    ['Juice', 'glass', '2 glasses', 3],
    ['Bread', 'loaf', '2 loaves', 3],
    ['Garlic', 'clove', '4 cloves', 5],
  ])('%s: a stocked %s and a bought "%s" are one unit', async (name, unit, line, total) => {
    db.seed('pantry_items', [{ id: `p-${name}`, family_id: FAMILY, name, quantity: 1, unit }]);
    bought(name, line);

    const result = await recordShoppingTripAction({ listId: LIST });

    expect(result).toMatchObject({ ok: true, unitMismatch: [] });
    expect(pantry()).toEqual([{ name, quantity: total, unit }]);
  });

  it('a row with no unit yet takes the bought one', async () => {
    db.seed('pantry_items', [{ id: 'p-oats', family_id: FAMILY, name: 'Oats', quantity: 0, unit: null }]);
    bought('Oats', '2 lb');

    await recordShoppingTripAction({ listId: LIST });

    expect(pantry()).toEqual([{ name: 'Oats', quantity: 2, unit: 'lb' }]);
  });
});

// AUD-1041-PANTRY-UNIT-CAS. The put-away is a read, a judgement and a
// conditional write, and an editor can change the row in between. The units
// are judged against the row each attempt writes over, and the write holds only
// while the row keeps the quantity AND the unit it was judged against.
describe('a put-away is judged against the row it writes, whatever an editor changed meanwhile', () => {
  /**
   * Change the pantry row once, as the put-away's first write is made: after
   * its read and its judgement, before the write's conditions are checked.
   */
  function editBeforeTheWrite(edit: Record<string, unknown>) {
    let done = false;
    mocks.createServer.mockResolvedValue(new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property !== 'from') return typeof value === 'function' ? value.bind(target) : value;
        return (table: string) => {
          const builder = target.from(table) as unknown as { update: (patch: unknown) => unknown };
          if (table !== 'pantry_items') return builder;
          const update = builder.update.bind(builder);
          builder.update = (patch: unknown) => {
            if (!done) {
              done = true;
              Object.assign(db.table('pantry_items').find((row) => row.id === 'p-rice')!, edit);
            }
            return update(patch);
          };
          return builder;
        };
      },
    }));
  }

  it.each([
    ['a unit-only edit', { unit: 'cup' }, { quantity: 3, unit: 'cup' }],
    ['a quantity and unit edit', { quantity: 2, unit: 'cups' }, { quantity: 2, unit: 'cups' }],
  ])('%s to cups leaves the bought kilogram out of the cups, and says so', async (_label, edit, after) => {
    db.seed('pantry_items', [{ id: 'p-rice', family_id: FAMILY, name: 'Rice', quantity: 3, unit: 'kg' }]);
    bought('Rice', '1 kg');
    editBeforeTheWrite(edit);

    const result = await recordShoppingTripAction({ listId: LIST });

    expect(result).toMatchObject({ ok: true, pantryUpdated: [], unitMismatch: [{ name: 'Rice', bought: 'kg', stocked: after.unit }] });
    expect(pantry()).toEqual([{ name: 'Rice', ...after }]);
  });

  it('a row with no unit that an editor gives one is not relabelled with the bought unit', async () => {
    db.seed('pantry_items', [{ id: 'p-rice', family_id: FAMILY, name: 'Rice', quantity: 3, unit: null }]);
    bought('Rice', '1 kg');
    editBeforeTheWrite({ unit: 'cup' });

    const result = await recordShoppingTripAction({ listId: LIST });

    expect(result).toMatchObject({ ok: true, pantryUpdated: [], unitMismatch: [{ name: 'Rice', bought: 'kg', stocked: 'cup' }] });
    expect(pantry()).toEqual([{ name: 'Rice', quantity: 3, unit: 'cup' }]);
  });

  it('control: a same-unit edit meanwhile is counted on top of, not over', async () => {
    db.seed('pantry_items', [{ id: 'p-rice', family_id: FAMILY, name: 'Rice', quantity: 3, unit: 'kg' }]);
    bought('Rice', '1 kg');
    editBeforeTheWrite({ quantity: 5 });

    const result = await recordShoppingTripAction({ listId: LIST });

    expect(result).toMatchObject({ ok: true, unitMismatch: [] });
    expect(pantry()).toEqual([{ name: 'Rice', quantity: 6, unit: 'kg' }]);
  });
});
