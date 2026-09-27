import { beforeEach, describe, expect, it, vi } from 'vitest';

// A database without 0443 (DATA-007): the default-list get-or-create answers
// "function missing" and falls back to the read-then-insert these cases were
// written against. tests/a-family-gets-one-default-list.test.ts covers the RPC path.
const missingDefaultListRpc = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });

/**
 * addMomentGroceryAction ("add this event's shopping to the list").
 *
 * It dropped both of its read errors: a failed read of the family's lists was
 * taken for "no list" and created a second "Groceries", and a failed read of
 * what was already on the list re-added all of it. It also took the family
 * from the caller rather than the session.
 */

const state = vi.hoisted(() => ({ writes: [] as string[], failRead: '' as '' | 'grocery_lists' | 'grocery_items' }));

function client() {
  return {
    rpc: missingDefaultListRpc,
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'order', 'limit']) chain[m] = () => chain;
      chain.insert = () => { state.writes.push(table); return { select: () => ({ single: async () => ({ data: { id: 'new-list' }, error: null }), then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: 'item' }], error: null }).then(r) }) }; };
      // One row, as PostgREST's maybeSingle answers — the list lookup reads it so.
      chain.maybeSingle = async () => (state.failRead === table
        ? { data: null, error: { code: 'XX000', message: 'Fixture read unavailable' } }
        : { data: table === 'grocery_lists' ? { id: 'list-1' } : null, error: null });
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(
        state.failRead === table
          ? { data: null, error: { code: 'XX000', message: 'Fixture read unavailable' } }
          : { data: table === 'grocery_lists' ? [{ id: 'list-1' }] : [], error: null },
      ).then(resolve);
      return chain;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => client() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-1' }, active: { familyId: 'family-1', role: 'parent', member: { id: 'm1' } } }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { addMomentGroceryAction } = await import('@/app/(app)/dashboard/moment-actions');

beforeEach(() => { state.writes = []; state.failRead = ''; });

describe('a moment’s shopping lands once, in the active family', () => {
  it('a failed list read creates no second "Groceries" list', async () => {
    state.failRead = 'grocery_lists';
    const result = await addMomentGroceryAction({ familyId: 'family-1', items: ['milk'] });
    expect(result).toMatchObject({ ok: false });
    expect(state.writes).toEqual([]);
  });

  it('a failed read of the list’s items re-adds nothing', async () => {
    state.failRead = 'grocery_items';
    const result = await addMomentGroceryAction({ familyId: 'family-1', items: ['milk'] });
    expect(result).toMatchObject({ ok: false });
    expect(state.writes).toEqual([]);
  });

  it('refuses a family other than the one the member is in', async () => {
    const result = await addMomentGroceryAction({ familyId: 'family-2', items: ['milk'] });
    expect(result).toMatchObject({ ok: false });
    expect(state.writes).toEqual([]);
  });

  it('still adds to the family’s list when the reads succeed', async () => {
    const result = await addMomentGroceryAction({ familyId: 'family-1', items: ['milk'] });
    expect(result).toMatchObject({ ok: true, added: 1 });
    expect(state.writes).toEqual(['grocery_items']);
  });
});
