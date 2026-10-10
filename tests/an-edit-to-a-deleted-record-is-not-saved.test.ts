// An edit to a record someone deleted is refused, not reported as saved.
//
// Contractors, warranties and the Auto records are soft-deleted: the delete
// stamps `deleted_at`, and every list skips such rows. Their update-by-id
// paths matched on `id` and `family_id` only, so an edit to a deleted row
// still found it, rewrote the hidden row, read back one row and said "saved",
// while the record stayed deleted and nothing the family could see changed.
// Two parents are enough: one deletes the plumber while the other still has
// the plumber's edit form open.
//
//   * `saveContractor` (lib/services/home) — the update by `id`;
//   * `saveContractorAction` and `saveWarrantyAction`
//     (app/(app)/dashboard/home/actions.ts) — the forms on the Home pages;
//   * `saveRow` (app/(app)/dashboard/auto/actions.ts) — every Auto form. Its
//     own comment says an already-deleted record must not report success; the
//     filter that would make that true was missing.
//
// Each update now also requires `deleted_at is null`, so the deleted row
// matches nothing and the zero-rows handling already there answers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { saveContractor } from '@/lib/services/home';
import { scopeForSystem } from '@/lib/services/scope';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'auth-parent' }, active: { familyId: 'fam-1', family: { timezone: 'UTC' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
import { saveContractorAction, saveWarrantyAction } from '@/app/(app)/dashboard/home/actions';
import { saveLicenseAction, saveVehicleAction } from '@/app/(app)/dashboard/auto/actions';

type DB = SupabaseClient<Database>;
const DELETED_AT = '2026-10-01T09:00:00Z';

let db: InMemorySupabase;
beforeEach(() => {
  db = createInMemorySupabase<DB>();
  h.db = db;
  db.seed('home_contractors', [
    { id: 'c-live', family_id: 'fam-1', name: 'Ace Plumbing', phone: '555-0100', deleted_at: null },
    { id: 'c-gone', family_id: 'fam-1', name: 'Bob Pipes', phone: '555-0101', deleted_at: DELETED_AT },
  ]);
  db.seed('home_warranties', [
    { id: 'w-live', family_id: 'fam-1', name: 'Dishwasher', deleted_at: null },
    { id: 'w-gone', family_id: 'fam-1', name: 'Old fridge', deleted_at: DELETED_AT },
  ]);
  db.seed('vehicles', [
    { id: 'v-live', family_id: 'fam-1', nickname: 'Van', deleted_at: null },
    { id: 'v-gone', family_id: 'fam-1', nickname: 'Sold sedan', deleted_at: DELETED_AT },
  ]);
  db.seed('driver_licenses', [
    { id: 'l-gone', family_id: 'fam-1', holder_name: 'Alex', deleted_at: DELETED_AT },
  ]);
});
afterEach(() => vi.restoreAllMocks());

const row = (table: string, id: string) => db.table(table).find((r) => r.id === id);

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
}

describe('saveContractor (the service, by id)', () => {
  const scope = () => scopeForSystem(db as unknown as DB, { id: 'fam-1', timezone: 'UTC' }, { role: 'parent', userId: 'auth-parent' });

  it('refuses an edit to a deleted contractor and leaves it untouched', async () => {
    const res = await saveContractor(scope(), { id: 'c-gone', name: 'Bob Pipes', phone: '555-0199' });

    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(row('home_contractors', 'c-gone')).toMatchObject({ phone: '555-0101', deleted_at: DELETED_AT });
  });

  it('still saves an edit to a live contractor', async () => {
    const res = await saveContractor(scope(), { id: 'c-live', name: 'Ace Plumbing', phone: '555-0199' });

    expect(res).toMatchObject({ ok: true, data: { created: false } });
    expect(row('home_contractors', 'c-live')).toMatchObject({ phone: '555-0199' });
  });
});

describe('the Home forms', () => {
  it('refuses a contractor edit for a contractor someone deleted', async () => {
    await expect(saveContractorAction(form({ id: 'c-gone', name: 'Bob Pipes', phone: '555-0199' }))).rejects.toThrow();
    expect(row('home_contractors', 'c-gone')).toMatchObject({ phone: '555-0101' });
  });

  it('refuses a warranty edit for a warranty someone deleted', async () => {
    await expect(saveWarrantyAction(form({ id: 'w-gone', name: 'Old fridge', expires_on: '2027-01-01' }))).rejects.toThrow();
    expect(row('home_warranties', 'w-gone')?.expires_on).toBeUndefined();
  });

  it('still saves edits to live ones', async () => {
    await expect(saveContractorAction(form({ id: 'c-live', name: 'Ace Plumbing', phone: '555-0199' }))).resolves.toBeUndefined();
    await expect(saveWarrantyAction(form({ id: 'w-live', name: 'Dishwasher', expires_on: '2027-01-01' }))).resolves.toBeUndefined();
    expect(row('home_contractors', 'c-live')).toMatchObject({ phone: '555-0199' });
    expect(row('home_warranties', 'w-live')).toMatchObject({ expires_on: '2027-01-01' });
  });
});

describe('the Auto forms', () => {
  it('refuses an edit to a vehicle or a license someone deleted', async () => {
    await expect(saveVehicleAction(form({ id: 'v-gone', nickname: 'Renamed' }))).rejects.toThrow();
    await expect(saveLicenseAction(form({ id: 'l-gone', holder_name: 'Renamed' }))).rejects.toThrow();
    expect(row('vehicles', 'v-gone')).toMatchObject({ nickname: 'Sold sedan' });
    expect(row('driver_licenses', 'l-gone')).toMatchObject({ holder_name: 'Alex' });
  });

  it('still saves an edit to a live vehicle', async () => {
    await expect(saveVehicleAction(form({ id: 'v-live', nickname: 'Big van' }))).resolves.toBeUndefined();
    expect(row('vehicles', 'v-live')).toMatchObject({ nickname: 'Big van' });
  });
});
