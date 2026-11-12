// The three pantry actions, called the way the pantry page calls them, by every
// household role, with valid input and with another family's ids.
//
// THE POLICY, from the sources rather than from the action:
//   - `pantry_items` is a household resource every member manages:
//     "Members can manage pantry_items" (supabase/migrations/00800_food_household.sql:43)
//     is the only permissive policy, and the pantry is a free feature
//     (lib/constants/feature-catalog.ts:83, no `manage` in navigation.ts).
//   - A guest is refused every write by the guard trigger 0481 attaches
//     (supabase/migrations/0481_the_rls_sweep_narrows_the_household_tables_to_their_roles.sql:769-777,
//     0464's `household_write_is_not_a_guests()`), answered 42501. The
//     in-memory client cannot run a trigger, so `withGuestGuard` answers the
//     same 42501 and the action's handling of it is what is asserted.
//   - The family is the session's, and an item of another family is "not
//     found" (lib/services/groceries `pantryAdjust`, `savePantryItem`,
//     `removePantryItem` all filter `family_id`).
//
// Mocked: the session, the server client factory, next/cache and the
// translator (the real en-US source catalogue through `translate`).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import {
  CALLERS, FAMILY_A, FAMILY_B, roleOf, userIdOf, withGuestGuard, type Caller,
} from './helpers/role-callers';

const harness = vi.hoisted(() => ({
  caller: 'parent' as string | null,
  db: null as unknown,
  revalidatePath: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { harness.revalidatePath.push(path); } }));
vi.mock('@/lib/supabase/auth', async () => {
  const callers = await import('./helpers/role-callers');
  return {
    requireUserContext: async () => (harness.caller
      ? callers.contextFor(harness.caller as Caller)
      : callers.signedOut()),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { adjustPantryQuantityAction, savePantryItemAction, removePantryItemAction } =
  await import('@/app/(app)/dashboard/pantry/actions');

const RICE_A = 'a0000000-0000-4000-8000-0000000a0101';
const RICE_B = 'b0000000-0000-4000-8000-0000000b0101';
const PERMISSION = "You don't have permission to do that. Ask a family admin if you think this is a mistake.";
const NOT_FOUND = 'That pantry item could not be found.';

/** Every caller the database lets change the pantry: everyone but a guest. */
const WRITERS: Caller[] = CALLERS.filter((c) => c !== 'guest');

let db: InMemorySupabase;
/** Every write the action SENT to pantry_items, landed or not. */
let writesSent: string[];
const pantry = () => db.table('pantry_items');
const item = (id: string) => pantry().find((row) => row.id === id) as Row | undefined;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  writesSent = [];
  const recorded = withFaults(db, (table, calls) => {
    if (table === 'pantry_items') {
      for (const call of calls) if (['insert', 'update', 'upsert', 'delete'].includes(call.method)) writesSent.push(call.method);
    }
    return null;
  });
  harness.db = withGuestGuard(recorded, ['pantry_items'], () => (harness.caller ? roleOf(harness.caller as Caller) : null));
  harness.caller = 'parent';
  harness.revalidatePath = [];
  db.seed('pantry_items', [
    { id: RICE_A, family_id: FAMILY_A, name: 'Rice', quantity: 3, unit: 'kg', location: 'pantry', category: 'pantry', created_by: userIdOf('parent') },
    { id: RICE_B, family_id: FAMILY_B, name: 'Rice', quantity: 5, unit: 'kg', location: 'pantry', category: 'pantry', created_by: userIdOf('parent', FAMILY_B) },
  ]);
});

const as = (caller: Caller | null) => { harness.caller = caller; };

describe('adjustPantryQuantityAction (ACTION-C144B7C6CB81)', () => {
  it.each(WRITERS)('ACTION-C144B7C6CB81 a %s takes one from an item of their own family', async (caller) => {
    as(caller);
    expect(await adjustPantryQuantityAction(RICE_A, -1)).toEqual({ ok: true, id: RICE_A });
    expect(item(RICE_A)?.quantity).toBe(2);
    expect(item(RICE_B)?.quantity).toBe(5);
    expect(harness.revalidatePath).toEqual(['/dashboard/pantry']);
  });

  it('ACTION-C144B7C6CB81 a guest is refused and the count is unchanged', async () => {
    as('guest');
    expect(await adjustPantryQuantityAction(RICE_A, -1)).toEqual({ ok: false, error: PERMISSION });
    expect(item(RICE_A)?.quantity).toBe(3);
    expect(harness.revalidatePath).toEqual([]);
  });

  it('ACTION-C144B7C6CB81 a signed-out caller is sent to sign in and nothing is written', async () => {
    as(null);
    await expect(adjustPantryQuantityAction(RICE_A, -1)).rejects.toThrow('NEXT_REDIRECT');
    expect(item(RICE_A)?.quantity).toBe(3);
    expect(writesSent).toEqual([]);
  });

  it("ACTION-C144B7C6CB81 another family's item is not found, no write is sent, and both counts stand", async () => {
    expect(await adjustPantryQuantityAction(RICE_B, -1)).toEqual({ ok: false, error: NOT_FOUND });
    expect(writesSent).toEqual([]);
    expect([item(RICE_A)?.quantity, item(RICE_B)?.quantity]).toEqual([3, 5]);
  });
});

describe('savePantryItemAction (ACTION-CF58A1319822)', () => {
  it.each(WRITERS)('ACTION-CF58A1319822 a %s adds an item to their own family, attributed to them', async (caller) => {
    as(caller);
    const result = await savePantryItemAction(null, { name: 'Oats', quantity: 2, unit: 'bag', location: 'pantry' });

    const added = pantry().filter((row) => row.name === 'Oats');
    expect(added).toEqual([expect.objectContaining({ family_id: FAMILY_A, quantity: 2, unit: 'bag', created_by: userIdOf(caller) })]);
    expect(result).toEqual({ ok: true, id: added[0].id });
  });

  it.each(WRITERS)('ACTION-CF58A1319822 a %s edits an item of their own family', async (caller) => {
    as(caller);
    expect(await savePantryItemAction(RICE_A, { name: 'Brown rice', lowThreshold: 1 })).toEqual({ ok: true, id: RICE_A });
    expect(item(RICE_A)).toEqual(expect.objectContaining({ name: 'Brown rice', low_threshold: 1, quantity: 3 }));
  });

  it('ACTION-CF58A1319822 a guest is refused an add and an edit, and nothing is written', async () => {
    as('guest');
    const before = structuredClone(pantry());
    expect(await savePantryItemAction(null, { name: 'Oats' })).toEqual({ ok: false, error: PERMISSION });
    expect(await savePantryItemAction(RICE_A, { name: 'Renamed by a guest' })).toEqual({ ok: false, error: PERMISSION });
    expect(pantry()).toEqual(before);
  });

  it("ACTION-CF58A1319822 another family's item is not found and neither family changes", async () => {
    const before = structuredClone(pantry());
    expect(await savePantryItemAction(RICE_B, { name: 'Taken over' })).toEqual({ ok: false, error: NOT_FOUND });
    expect(pantry()).toEqual(before);
  });
});

describe('removePantryItemAction (ACTION-CF5B816455B8)', () => {
  it.each(WRITERS)('ACTION-CF5B816455B8 a %s removes an item of their own family', async (caller) => {
    as(caller);
    expect(await removePantryItemAction(RICE_A)).toEqual({ ok: true, id: RICE_A });
    expect(pantry().map((row) => row.id)).toEqual([RICE_B]);
  });

  it('ACTION-CF5B816455B8 a guest is refused and the item stays', async () => {
    as('guest');
    expect(await removePantryItemAction(RICE_A)).toEqual({ ok: false, error: PERMISSION });
    expect(pantry().map((row) => row.id)).toEqual([RICE_A, RICE_B]);
  });

  it("ACTION-CF5B816455B8 another family's item is not found and is not removed", async () => {
    expect(await removePantryItemAction(RICE_B)).toEqual({ ok: false, error: NOT_FOUND });
    expect(pantry().map((row) => row.id)).toEqual([RICE_A, RICE_B]);
  });
});
