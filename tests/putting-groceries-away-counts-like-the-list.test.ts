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

  it('a row with no unit yet takes the bought one', async () => {
    db.seed('pantry_items', [{ id: 'p-oats', family_id: FAMILY, name: 'Oats', quantity: 0, unit: null }]);
    bought('Oats', '2 lb');

    await recordShoppingTripAction({ listId: LIST });

    expect(pantry()).toEqual([{ name: 'Oats', quantity: 2, unit: 'lb' }]);
  });
});
