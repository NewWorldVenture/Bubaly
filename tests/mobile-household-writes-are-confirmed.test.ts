import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../mobile/src/lib/db';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// The phone's chore "Done" and grocery check-off wrote by id alone and treated
// "no error" as "it happened". Under RLS a refused UPDATE is not an error: the
// row is filtered out by the policy's USING clause and PostgREST answers 204
// with zero rows. So the screen marked the chore "Waiting for approval" / the
// item checked while the database had not changed.
//
//  - chore_assignments UPDATE is own-assignment-or-manager (0374). The Chores
//    tab lists the whole family's open chores with a Done button on each, so a
//    child tapping Done on a sibling's chore was told it was submitted.
//  - The write did not say which status it was moving FROM. A parent's phone
//    holding a list loaded before the chore was approved on the web turned the
//    approved chore back into "submitted" on Done — the 0223/0374 guards stop a
//    non-manager doing that, not a manager — and with it the child's points.
//
// Runtime imports stay dynamic so the web TS project does not absorb the
// separate mobile one; the native client and config are replaced here.
vi.mock('../mobile/src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../mobile/src/lib/config', () => ({ config: { apiUrl: 'https://example.invalid' } }));
const queriesModule = '../mobile/src/lib/queries';
const { completeChore, setGroceryChecked } = await import(queriesModule) as {
  completeChore: (db: Db, row: ChoreRow, familyId: string) => Promise<void>;
  setGroceryChecked: (db: Db, id: string, isChecked: boolean, familyId: string) => Promise<void>;
};

// queries.ts's ChoreRow, restated: a type import would pull the native client
// into the web TS project.
type ChoreRow = {
  id: string; status: string; due_at: string | null; member_id: string;
  chores: { title: string; points: number; requires_approval: boolean } | null;
  family_members: { display_name: string } | null;
};

const FAMILY = 'family-1';
const OTHER = 'family-2';

const choreRow = (id: string, status: string): ChoreRow => ({
  id, status, due_at: null, member_id: 'member-sibling',
  chores: { title: 'Dishes', points: 10, requires_approval: true }, family_members: { display_name: 'Sam' },
});

/** RLS's USING clause hides the row from this caller's UPDATE: no error, no rows. */
function rlsHidesUpdatesOn(db: InMemorySupabase, table: string): Db {
  return {
    from(name: string) {
      const builder = db.from(name);
      if (name !== table) return builder;
      const update = builder.update.bind(builder);
      builder.update = (patch: Record<string, unknown>) => update(patch).eq('id', '__hidden_by_rls__');
      return builder;
    },
  } as unknown as Db;
}

describe('a chore marked Done on the phone is one the database moved', () => {
  it('submits an open chore of the current family', async () => {
    const db = createInMemorySupabase();
    db.seed('chore_assignments', [{ id: 'a1', family_id: FAMILY, member_id: 'member-self', status: 'todo' }]);
    await expect(completeChore(db as unknown as Db, choreRow('a1', 'todo'), FAMILY)).resolves.toBeUndefined();
    expect(db.table('chore_assignments')[0]).toMatchObject({ status: 'submitted' });
  });

  it('refuses, rather than reports, a Done that RLS filtered out (a sibling’s chore)', async () => {
    const db = createInMemorySupabase();
    db.seed('chore_assignments', [{ id: 'a1', family_id: FAMILY, member_id: 'member-sibling', status: 'todo' }]);
    await expect(completeChore(rlsHidesUpdatesOn(db, 'chore_assignments'), choreRow('a1', 'todo'), FAMILY)).rejects.toThrow();
    expect(db.table('chore_assignments')[0]).toMatchObject({ status: 'todo' });
  });

  it.each(['approved', 'rejected', 'done', 'submitted'])('does not reopen a chore that is already %s', async (status) => {
    const db = createInMemorySupabase();
    db.seed('chore_assignments', [{ id: 'a1', family_id: FAMILY, member_id: 'member-child', status, approved_at: '2026-10-08T12:00:00Z' }]);
    // The phone still shows the row as it was when the list loaded.
    await expect(completeChore(db as unknown as Db, choreRow('a1', 'todo'), FAMILY)).rejects.toThrow();
    expect(db.table('chore_assignments')[0]).toMatchObject({ status, approved_at: '2026-10-08T12:00:00Z' });
  });

  it('does not write a chore that belongs to a family other than the one on screen', async () => {
    const db = createInMemorySupabase();
    db.seed('chore_assignments', [{ id: 'a1', family_id: OTHER, member_id: 'member-self', status: 'todo' }]);
    await expect(completeChore(db as unknown as Db, choreRow('a1', 'todo'), FAMILY)).rejects.toThrow();
    expect(db.table('chore_assignments')[0]).toMatchObject({ status: 'todo' });
  });
});

describe('a grocery item checked on the phone is one the database changed', () => {
  it('checks an item of the current family', async () => {
    const db = createInMemorySupabase();
    db.seed('grocery_items', [{ id: 'i1', family_id: FAMILY, list_id: 'l1', name: 'Milk', is_checked: false }]);
    await expect(setGroceryChecked(db as unknown as Db, 'i1', true, FAMILY)).resolves.toBeUndefined();
    expect(db.table('grocery_items')[0]).toMatchObject({ is_checked: true });
  });

  it('refuses when the item is gone (removed on another device) so the screen rolls back', async () => {
    const db = createInMemorySupabase();
    await expect(setGroceryChecked(db as unknown as Db, 'i1', true, FAMILY)).rejects.toThrow();
  });

  it('refuses when RLS filtered the update out', async () => {
    const db = createInMemorySupabase();
    db.seed('grocery_items', [{ id: 'i1', family_id: FAMILY, list_id: 'l1', name: 'Milk', is_checked: false }]);
    await expect(setGroceryChecked(rlsHidesUpdatesOn(db, 'grocery_items'), 'i1', true, FAMILY)).rejects.toThrow();
    expect(db.table('grocery_items')[0]).toMatchObject({ is_checked: false });
  });

  it('does not write an item of a family other than the one on screen', async () => {
    const db = createInMemorySupabase();
    db.seed('grocery_items', [{ id: 'i1', family_id: OTHER, list_id: 'l1', name: 'Milk', is_checked: false }]);
    await expect(setGroceryChecked(db as unknown as Db, 'i1', true, FAMILY)).rejects.toThrow();
    expect(db.table('grocery_items')[0]).toMatchObject({ is_checked: false });
  });
});
