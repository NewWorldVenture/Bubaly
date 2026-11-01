// The onboarding funnel's "Imported a calendar" and "Calendar imported
// (session 1)" are rates over every household, read from the
// `calendar_imported` milestone. An ICS feed added in Settings and the
// onboarding wizard's import recorded it; the importer at /dashboard/migrate
// did not, though it is where a family moving from Google, iCloud or Cozi
// brings its calendar export (lib/migrate/competitors.ts). Driven through the
// real commitImport, the real server milestone writer and the real funnel
// reads over the in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ client: null as unknown, ctx: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => h.ctx }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.client }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { commitImport } = await import('@/app/(app)/dashboard/migrate/actions');
const { loadActivationTelemetry } = await import('@/lib/analytics/onboarding-server');
const { summarizeActivation } = await import('@/lib/analytics/activation');

type DB = SupabaseClient<Database>;
const FAMILY = '10000000-0000-4000-8000-000000000001';
const MEMBER = '20000000-0000-4000-8000-000000000002';
const USER = 'auth-ada';
const SIGNUP = '2026-09-10T11:50:00.000Z';
let db: ReturnType<typeof createInMemorySupabase<DB>>;

const event = (title: string, startsAt = '2026-09-12T09:00:00.000Z') => ({
  title, startsAt, endsAt: null, allDay: false, location: null, description: null,
});
const imported = () => db.table('activation_events').filter((row) => row.milestone === 'calendar_imported');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
  db = createInMemorySupabase<DB>({ defaults: { grocery_lists: { is_archived: false, archived_at: null }, grocery_items: { is_checked: false } } });
  h.client = db;
  h.ctx = {
    user: { id: USER },
    active: { familyId: FAMILY, role: 'parent', member: { id: MEMBER }, family: { id: FAMILY, created_at: SIGNUP, timezone: 'UTC' } },
  };
  db.seed('families', [{ id: FAMILY, name: 'Ada family', created_at: SIGNUP }]);
  db.seed('family_members', [{ id: MEMBER, family_id: FAMILY, user_id: USER, display_name: 'Ada', role: 'parent', is_active: true }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a calendar brought over from another app is the household’s calendar_imported (N9)', () => {
  it('is recorded once, by the member, for the household, in its first session, and the funnel counts it', async () => {
    expect(await commitImport({ source: 'cozi', events: [event('Swim practice')] })).toMatchObject({ ok: true, counts: { events: 1 } });
    expect(await commitImport({ source: 'google', events: [event('Piano', '2026-09-13T16:00:00.000Z')] })).toMatchObject({ ok: true, counts: { events: 1 } });
    expect(imported()).toEqual([expect.objectContaining({
      user_id: USER, family_id: FAMILY, session_id: FAMILY, session_index: 1, ms_since_signup: 600_000,
    })]);

    const telemetry = await loadActivationTelemetry(db as unknown as DB, new Date());
    if (!telemetry.data) throw new Error('activation telemetry unavailable');
    const summary = summarizeActivation(telemetry.data.events, { cohorts: telemetry.data.cohorts });
    expect(summary.session1.calendarImportRate).toBe(1);
    expect(summary.milestoneReach.find((m) => m.key === 'calendar_imported')).toMatchObject({ cohorts: 1, rate: 1 });
  });

  it('is recorded when a later batch of events fails, since the first batch landed', async () => {
    // The importer writes events 500 at a time. The second batch is refused.
    let eventInserts = 0;
    h.client = withFaults(db, (table, calls) => (
      table === 'calendar_events' && calls.some((call) => call.method === 'insert') && ++eventInserts === 2
        ? { code: '08006', message: 'connection failed' } : null));
    const events = Array.from({ length: 501 }, (_, i) => event(`Practice ${i}`));
    expect(await commitImport({ source: 'icloud', events })).toEqual({ ok: false, error: 'migrateActions.theImportStoppedPartWayThrough' });
    expect(db.table('calendar_events')).toHaveLength(500);
    expect(imported()).toEqual([expect.objectContaining({ user_id: USER, family_id: FAMILY, session_index: 1 })]);
  });

  it('is not recorded for an import that brought no events in', async () => {
    // A file of chores and notes only.
    expect(await commitImport({ source: 'cozi', tasks: [{ name: 'Take the bins out' }], notes: [{ name: 'Wifi code', extra: 'hunter2' }] }))
      .toMatchObject({ ok: true, counts: { events: 0, tasks: 1, notes: 1 } });
    // And a file whose every event is already on the calendar.
    db.seed('calendar_events', [{ family_id: FAMILY, title: 'Swim practice', starts_at: '2026-09-12T09:00:00.000Z', created_by: USER }]);
    expect(await commitImport({ source: 'google', events: [event('Swim practice')] })).toMatchObject({ ok: true, counts: { events: 0 }, skipped: 1 });
    expect(imported()).toEqual([]);
  });
});
