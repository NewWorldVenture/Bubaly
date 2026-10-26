// `addLeftoverAction` (app/(app)/dashboard/kitchen/actions.ts) ended with
// `return { ok: true, data: { id: data!.id } }` after
// `insert(...).select('id').maybeSingle()`. An insert the database admits but
// whose row the follow-up select cannot see answers `data: null` with no
// error, and the action then threw a TypeError instead of answering, so the
// "log a leftover" form had nothing to show. It now treats a save that comes
// back with no row as a failed save, with a message the form can toast, the
// way the other confirmed writes on this page do.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'parent-1' },
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'mem-1' }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { addLeftoverAction } = await import('@/app/(app)/dashboard/kitchen/actions');

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase();
  db.replace('leftover_inventory', []);
  state.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The insert lands; the row read back with it is not visible (data: null, no error). */
function hideTheSavedRow() {
  const realFrom = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation(((table: string) => {
    const builder = realFrom(table) as unknown as Record<string, unknown>;
    if (table === 'leftover_inventory') {
      const maybeSingle = builder.maybeSingle as () => Promise<{ data: unknown; error: unknown }>;
      builder.maybeSingle = async () => ({ ...(await maybeSingle.call(builder)), data: null, error: null });
    }
    return builder;
  }) as unknown as typeof db.from);
}

describe('addLeftoverAction', () => {
  it('answers a save that came back with no row as a failure, rather than crashing', async () => {
    hideTheSavedRow();
    const res = await addLeftoverAction({ name: 'Chili', quantity: '2 bowls', location: 'fridge' });
    expect(res).toEqual({ ok: false, error: 'actions.couldNotConfirmThatLeftoverWasSaved' });
  });

  it('still logs a leftover and returns its id', async () => {
    const res = await addLeftoverAction({ name: ' Chili ', sourceMeal: 'Tuesday dinner', quantity: '2 bowls', location: 'fridge' });
    expect(res.ok).toBe(true);
    const rows = db.table('leftover_inventory');
    expect(rows).toEqual([expect.objectContaining({ family_id: 'fam-1', name: 'Chili', source_meal: 'Tuesday dinner', created_by: 'parent-1' })]);
    expect(res).toEqual({ ok: true, data: { id: rows[0].id } });
  });
});
