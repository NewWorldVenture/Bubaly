import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// S10 — logging a service visit after the fact moved the asset's
// `last_serviced_on` BACK to the visit's date.
//
// The dashboard's service form defaults the date to today but lets it be
// edited, and the assistant's `home.createServiceRecord` takes any date: both
// wrote the visit's date over the asset's unconditionally (and the assistant
// path the contractor's `last_used_on` too). Typing in a 2024 receipt for a
// furnace serviced last month made it "last serviced in 2024": every task
// "Schedule recommended" then built from that date was already overdue, and
// the maintenance page and the forecast showed the old date. Deleting the
// visit that set the date never took it back off the asset either.
//
// Driven through the REAL dashboard actions and the REAL service.

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: null },
    memberships: [],
    active: { familyId: 'family-1', role: 'parent', member: { id: 'member-1', family_id: 'family-1' }, family: { id: 'family-1', timezone: 'America/Los_Angeles' } },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { saveServiceRecordAction, deleteServiceRecordAction } = await import('@/app/(app)/dashboard/home/actions');
const { createServiceRecord } = await import('@/lib/services/home');
const { scopeForSystem } = await import('@/lib/services/scope');

type DB = SupabaseClient<Database>;
let db: InMemorySupabase;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T18:00:00Z'));
  db = createInMemorySupabase<DB>({ defaults: { home_service_records: { deleted_at: null }, home_contractors: { deleted_at: null } } });
  harness.db = db;
  db.seed('home_assets', [{ id: 'furnace', family_id: FAMILY, name: 'Furnace', category: 'hvac', last_serviced_on: '2026-09-01' }]);
  db.seed('home_contractors', [{ id: 'ace', family_id: FAMILY, name: 'Ace Heating', last_used_on: '2026-09-01' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const furnace = () => db.table('home_assets')[0];
const record = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [key, value] of Object.entries({ asset_id: 'furnace', title: 'Annual service', ...fields })) fd.set(key, value);
  return saveServiceRecordAction(fd);
};

describe('the dashboard service form', () => {
  it('logs a 2024 visit without moving the furnace\'s last service back to 2024', async () => {
    await record({ service_date: '2024-03-01' });

    expect(db.table('home_service_records').map((row) => row.service_date)).toEqual(['2024-03-01']);
    expect(furnace().last_serviced_on).toBe('2026-09-01');
    // The ordinary case is not a failure, and is not logged as one.
    expect(console.error).not.toHaveBeenCalled();
  });

  it('a later visit still moves it forward', async () => {
    await record({ service_date: '2026-10-10' });
    expect(furnace().last_serviced_on).toBe('2026-10-10');
  });

  it('an asset with no date yet takes the visit\'s, however old', async () => {
    furnace().last_serviced_on = null;
    await record({ service_date: '2024-03-01' });
    expect(furnace().last_serviced_on).toBe('2024-03-01');
  });

  it('deleting the visit that set the date falls back to the latest visit still on file', async () => {
    db.seed('home_service_records', [{ id: 'visit-sept', family_id: FAMILY, asset_id: 'furnace', title: 'Filter', service_date: '2026-09-01' }]);
    await record({ service_date: '2026-10-10' });
    const october = db.table('home_service_records').find((row) => row.service_date === '2026-10-10')!;

    await deleteServiceRecordAction(october.id as string);

    expect(furnace().last_serviced_on).toBe('2026-09-01');
  });

  it('deleting an older visit leaves a later date alone', async () => {
    db.seed('home_service_records', [{ id: 'visit-old', family_id: FAMILY, asset_id: 'furnace', title: 'Old', service_date: '2025-01-15' }]);

    await deleteServiceRecordAction('visit-old');

    expect(furnace().last_serviced_on).toBe('2026-09-01');
  });
});

describe('the assistant\'s createServiceRecord', () => {
  const scope = () => scopeForSystem(db as unknown as DB, { id: FAMILY, timezone: 'America/Los_Angeles' }, { role: 'parent', userId: 'user-1' });

  it('moves neither the asset nor the contractor back for a backdated visit', async () => {
    const res = await createServiceRecord(scope(), { title: 'Old repair', serviceDate: '2024-03-01', assetId: 'furnace', contractorId: 'ace' });

    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(furnace().last_serviced_on).toBe('2026-09-01');
    expect(db.table('home_contractors')[0].last_used_on).toBe('2026-09-01');
  });

  it('moves both forward for a newer one', async () => {
    await createServiceRecord(scope(), { title: 'Tune-up', serviceDate: '2026-10-12', assetId: 'furnace', contractorId: 'ace' });

    expect(furnace().last_serviced_on).toBe('2026-10-12');
    expect(db.table('home_contractors')[0].last_used_on).toBe('2026-10-12');
  });
});
