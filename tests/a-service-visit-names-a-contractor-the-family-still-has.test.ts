// A service visit names a contractor the family still has.
//
// `createServiceRecord` (lib/services/home, behind the assistant's
// `home.createServiceRecord`) stored `contractor_id` exactly as given and then
// stamped that contractor's `last_used_on`. It never asked whether the id was
// a live contractor of THIS family:
//
//   * a contractor the family had deleted got a new visit and a fresh "last
//     used" date on its hidden row, the row every list skips;
//   * another family's contractor id was stored on this family's record (the
//     foreign key checks existence, not family); the family-scoped bump only
//     logged a miss.
//
// The contractor is now read first, by id, family and `deleted_at is null`,
// and a missing one refuses the visit before anything is written.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceRecord } from '@/lib/services/home';
import { scopeForSystem } from '@/lib/services/scope';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;
const DELETED_AT = '2026-09-01T09:00:00Z';

function household(): { db: InMemorySupabase; scope: (extra?: Partial<ServiceScope>) => ServiceScope } {
  const db = createInMemorySupabase<DB>();
  db.seed('home_contractors', [
    { id: 'c-live', family_id: 'fam-1', name: 'Ace Plumbing', last_used_on: '2026-01-01', deleted_at: null },
    { id: 'c-gone', family_id: 'fam-1', name: 'Bob Pipes', last_used_on: '2026-01-01', deleted_at: DELETED_AT },
    { id: 'c-theirs', family_id: 'fam-2', name: 'Their plumber', last_used_on: '2026-01-01', deleted_at: null },
  ]);
  return {
    db,
    scope: (extra = {}) => scopeForSystem(db as unknown as DB, { id: 'fam-1', timezone: 'UTC' }, { role: 'parent', userId: 'auth-parent', ...extra }),
  };
}

const visits = (db: InMemorySupabase) => db.table('home_service_records');
const contractor = (db: InMemorySupabase, id: string) => db.table('home_contractors').find((row) => row.id === id);

describe('createServiceRecord and its contractor', () => {
  it('links a live contractor and records when they were last used', async () => {
    const { db, scope } = household();
    const res = await createServiceRecord(scope(), { title: 'Fixed the sink', serviceDate: '2026-09-05', contractorId: 'c-live' });

    expect(res).toMatchObject({ ok: true, data: { contractor_id: 'c-live' } });
    expect(contractor(db, 'c-live')).toMatchObject({ last_used_on: '2026-09-05' });
  });

  it('refuses a contractor the family deleted, and writes nothing', async () => {
    const { db, scope } = household();
    const res = await createServiceRecord(scope(), { title: 'Fixed the sink', serviceDate: '2026-09-05', contractorId: 'c-gone' });

    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(visits(db)).toHaveLength(0);
    expect(contractor(db, 'c-gone')).toMatchObject({ last_used_on: '2026-01-01' });
  });

  it('refuses another family’s contractor, and writes nothing', async () => {
    const { db, scope } = household();
    const res = await createServiceRecord(scope(), { title: 'Fixed the sink', serviceDate: '2026-09-05', contractorId: 'c-theirs' });

    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(visits(db)).toHaveLength(0);
    expect(contractor(db, 'c-theirs')).toMatchObject({ last_used_on: '2026-01-01' });
  });

  it('still logs a visit with no contractor', async () => {
    const { db, scope } = household();
    const res = await createServiceRecord(scope(), { title: 'Cleaned the gutters', serviceDate: '2026-09-05' });

    expect(res).toMatchObject({ ok: true, data: { contractor_id: null } });
    expect(visits(db)).toHaveLength(1);
  });

  it('does not bump a contractor deleted while the visit was being saved', async () => {
    const { db } = household();
    // Someone deletes the contractor between the check and the bump.
    const racing = {
      from: (table: string) => {
        if (table === 'home_service_records') contractor(db, 'c-live')!.deleted_at = DELETED_AT;
        return db.from(table);
      },
    } as unknown as DB;
    const scope = scopeForSystem(racing, { id: 'fam-1', timezone: 'UTC' }, { role: 'parent', userId: 'auth-parent' });

    const res = await createServiceRecord(scope, { title: 'Fixed the sink', serviceDate: '2026-09-05', contractorId: 'c-live' });

    expect(res.ok).toBe(true);
    expect(contractor(db, 'c-live')).toMatchObject({ last_used_on: '2026-01-01' });
  });

  it('writes nothing when the contractor could not be checked', async () => {
    const { db } = household();
    const failing = {
      from: (table: string) => {
        if (table !== 'home_contractors') return db.from(table);
        const reply = { data: null, error: { code: '08006', message: 'connection lost', details: null, hint: null } };
        const chain: Record<string, unknown> = {};
        for (const method of ['select', 'eq', 'is', 'update']) chain[method] = () => chain;
        chain.maybeSingle = async () => reply;
        chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(reply).then(resolve);
        return chain;
      },
    } as unknown as DB;
    const scope = scopeForSystem(failing, { id: 'fam-1', timezone: 'UTC' }, { role: 'parent', userId: 'auth-parent' });

    const res = await createServiceRecord(scope, { title: 'Fixed the sink', serviceDate: '2026-09-05', contractorId: 'c-live' });

    expect(res).toMatchObject({ ok: false, code: 'db' });
    expect(visits(db)).toHaveLength(0);
  });

  it('answers a retry of a visit already saved, even after the contractor was deleted', async () => {
    const { db, scope } = household();
    const first = await createServiceRecord(scope({ runId: 'run-1' }), { title: 'Fixed the sink', serviceDate: '2026-09-05', contractorId: 'c-live' });
    expect(first.ok).toBe(true);
    contractor(db, 'c-live')!.deleted_at = DELETED_AT;

    const retry = await createServiceRecord(scope({ runId: 'run-1' }), { title: 'Fixed the sink', serviceDate: '2026-09-05', contractorId: 'c-live' });

    expect(retry).toMatchObject({ ok: true, data: { contractor_id: 'c-live' } });
    expect(visits(db)).toHaveLength(1);
  });
});
