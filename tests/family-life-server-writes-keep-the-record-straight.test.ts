import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

// The family-life server actions, services and pages, driven through their real
// entry points against an in-memory database:
//
//   relationship actions   a removed date left its calendar event; an edited
//                          one left it on the old day (F17)
//   auto actions           a back-dated service set the odometer back, and a
//                          negative mileage was stored (F9/F26); rental times
//                          were stored as UTC wall time (F21)
//   independence action    "Start" from a stale page reverted an achievement (F18)
//   life events            reminders chosen on Greenwich's day (F19)
//   notifications          a failed relationship_dates read was silent (F39)
//   pages                  wish lists and celebrations ignored their tier (F34);
//                          a guest reached the utilities page (F6)

const h = vi.hoisted(() => ({
  db: null as unknown,
  tz: 'UTC',
  requireFeature: vi.fn(async (_href: string) => ({})),
  redirect: vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); }),
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: 'family-1', role: 'parent', member: { id: 'member-1' }, family: { name: 'Family One', timezone: h.tz } },
  }),
  requireFeature: h.requireFeature,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({ redirect: h.redirect, notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));
vi.mock('@/components/outcomes/related-outcomes', () => ({ RelatedOutcomes: () => null }));

const relationship = await import('@/app/(app)/dashboard/relationship/actions');
const auto = await import('@/app/(app)/dashboard/auto/actions');
const { startMilestoneAction } = await import('@/app/(app)/dashboard/independence/actions');
const { launchLifeEvent } = await import('@/lib/life-events/launch');
const { generateFamilyNotifications } = await import('@/lib/server/notifications');

const FAMILY = 'family-1';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      calendar_events: { description: null, location: null, ends_at: null, all_day: false, category: 'general', recurrence: 'none', recurrence_until: null, assignee_id: null, idempotency_key: null, feed_id: null, external_uid: null },
      relationship_dates: { recurs_annually: false, location: null, notes: null, calendar_event_id: null, member_id: null, reminder_days_before: 7, status: 'upcoming' },
    },
  });
  h.db = db;
  h.tz = 'UTC';
  h.requireFeature.mockClear();
  h.redirect.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

describe('a relationship date and its calendar event stay one thing (F17)', () => {
  beforeEach(() => {
    db.seed('relationship_dates', [{ id: 'date-1', family_id: FAMILY, kind: 'anniversary', title: 'Our anniversary', event_date: '2026-11-14', recurs_annually: true }]);
  });
  const events = () => db.table('calendar_events').filter((e) => e.family_id === FAMILY);

  it('removing a date on the calendar removes its event too', async () => {
    expect((await relationship.toggleDateOnCalendarAction('date-1')).ok).toBe(true);
    expect(events()).toHaveLength(1);

    expect(await relationship.removeRelationshipDateAction('date-1')).toEqual({ ok: true });
    expect(db.table('relationship_dates')).toEqual([]);
    expect(events()).toEqual([]);
  });

  it('an edited date moves its event with it', async () => {
    await relationship.toggleDateOnCalendarAction('date-1');
    // The module's edit writes the date row, then asks for the event to follow.
    Object.assign(db.table('relationship_dates')[0], { event_date: '2026-11-21', title: 'Ten years' });
    expect(await relationship.syncDateOnCalendarAction('date-1')).toEqual({ ok: true });
    expect(events()[0]).toMatchObject({ title: 'Ten years', starts_at: '2026-11-21T00:00:00.000Z' });
  });
});

describe('the odometer only moves forward (F9/F26)', () => {
  beforeEach(() => {
    db.seed('vehicles', [{ id: 'car-1', family_id: FAMILY, nickname: 'Blue car', mileage: 52000, deleted_at: null }]);
  });

  it('logging last spring\'s oil change keeps today\'s reading', async () => {
    await auto.saveAutoServiceAction(form({ vehicle_id: 'car-1', title: 'Oil change', service_date: '2025-03-01', mileage: '30000' }));
    expect(db.table('auto_service_records')).toHaveLength(1);
    expect(db.table('vehicles')[0].mileage).toBe(52000);
  });

  it('a newer, higher reading still moves it', async () => {
    await auto.saveAutoServiceAction(form({ vehicle_id: 'car-1', title: 'Tyres', mileage: '53000' }));
    expect(db.table('vehicles')[0].mileage).toBe(53000);
  });

  it('a negative reading is refused, and stored nowhere', async () => {
    await expect(auto.saveAutoServiceAction(form({ vehicle_id: 'car-1', title: 'Typo', mileage: '-5' }))).rejects.toThrow('actions.aMileageCannotBeNegative');
    expect(db.table('auto_service_records')).toEqual([]);
    expect(db.table('vehicles')[0].mileage).toBe(52000);
  });
});

describe('a rental pickup is the family\'s wall time (F21)', () => {
  it('1am on the 15th in New York is stored as that instant, not 01:00 UTC', async () => {
    h.tz = 'America/New_York';
    await auto.saveRentalAction(form({ company: 'Enterprise', pickup_at: '2026-10-15T01:00', return_at: '2026-10-18T22:00' }));
    expect(db.table('rental_cars')[0]).toMatchObject({ pickup_at: '2026-10-15T05:00:00.000Z', return_at: '2026-10-19T02:00:00.000Z' });
  });
});

describe('"Start" never rewrites a rung already on the ladder (F18)', () => {
  it('an achieved rung stays achieved when a stale page starts it again', async () => {
    const { LADDER } = await import('@/lib/independence/progression');
    const rung = LADDER[0];
    // The unique key the upsert names: family, member, domain and title.
    const ladder = createInMemorySupabase<SupabaseClient<Database>>({ uniques: { independence_milestones: [['family_id', 'member_id', 'domain', 'title']] } });
    ladder.seed('family_members', [{ id: 'kid', family_id: FAMILY, display_name: 'Kit', role: 'child', is_active: true }]);
    ladder.seed('independence_milestones', [{ id: 'm1', family_id: FAMILY, member_id: 'kid', domain: rung.domain, title: rung.title, status: 'achieved', achieved_at: '2026-10-01T00:00:00Z', evidence: 'Did it all week' }]);
    h.db = ladder;

    expect(await startMilestoneAction('kid', rung.title)).toEqual({ ok: true });
    expect(ladder.table('independence_milestones')).toEqual([expect.objectContaining({ id: 'm1', status: 'achieved', evidence: 'Did it all week' })]);
  });
});

describe('life-event reminders are chosen on the family\'s day (F19)', () => {
  it('a Tokyo morning launch does not remind about an item due the family\'s yesterday', async () => {
    db.seed('family_members', [{ id: 'member-1', family_id: FAMILY, user_id: 'user-1', role: 'parent', is_active: true }]);
    // 08:30 on 11 March in Tokyo; still the 10th at Greenwich.
    const now = new Date('2026-03-10T23:30:00Z');
    const scope = { db, familyId: FAMILY, userId: 'user-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'Asia/Tokyo', now } as unknown as ServiceScope;
    // "Finalize the birth plan" is 7 days before the birth: due on the 10th.
    const result = await launchLifeEvent(scope, { templateKey: 'new_baby', eventDate: '2026-03-17' });
    expect(result.ok).toBe(true);
    const titles = db.table('family_reminders').map((r) => r.title);
    expect(titles).not.toContain('Finalize the birth plan');
    expect(titles).toContain('Add baby to health insurance');
  });
});

describe('a broken relationship-dates read is reported (F39)', () => {
  it('logs the failure, as every other source read does', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const faulty = withFaults(db, (table, calls) => (table === 'relationship_dates' && calls.some((c) => c.method === 'select') ? { message: 'permission denied for table relationship_dates' } : null));
    db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
    await generateFamilyNotifications(faulty as never, FAMILY);
    expect(errors).toHaveBeenCalledWith('[notifications] generation source read failed', expect.objectContaining({ familyId: FAMILY, table: 'relationship_dates' }));
  });
});

describe('pages answer to their gates', () => {
  it.each([
    ['wishlists', '@/app/(app)/dashboard/wishlists/page', '/dashboard/wishlists'],
    ['celebrations', '@/app/(app)/dashboard/celebrations/page', '/dashboard/celebrations'],
  ])('the %s page asks its catalog gate (F34)', async (_name, path, href) => {
    const page = (await import(/* @vite-ignore */ path)).default as () => Promise<unknown>;
    await page();
    expect(h.requireFeature).toHaveBeenCalledWith(href);
  });

  it('a guest is sent away from the utilities page, and is not offered its link (F6)', async () => {
    const { refuseGuest } = await import('@/lib/auth/guest-scope');
    const { isNavItemVisibleToRole } = await import('@/lib/constants/navigation');
    expect(() => refuseGuest({ active: { role: 'guest' } } as never, '/dashboard/utilities')).toThrow('NEXT_REDIRECT /dashboard/grandparent-portal');
    expect(() => refuseGuest({ active: { role: 'caregiver' } } as never, '/dashboard/utilities')).not.toThrow();
    expect(isNavItemVisibleToRole({ href: '/dashboard/utilities', label: 'Utilities', icon: (() => null) as never }, { isManager: false, isGuest: true })).toBe(false);
  });
});
