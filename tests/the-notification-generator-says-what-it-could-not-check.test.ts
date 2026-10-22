// generateFamilyNotifications and the paths around it, against the in-memory
// database, for four findings:
//
// A3  — a failed medication_doses read made every dose already given look
//       pending, and a failed medication_due dedupe read re-inserted (and so
//       re-pushed and re-emailed) every medication reminder of the day.
// A15 — failed reads were only logged (some not even that): a failed chore
//       title read wrote a permanent "Chore due: Task", the Scan button said
//       "You're all caught up" and both crons answered 200 ok.
// A19 — family-wide notices were one shared row, so any member's "mark all
//       read" (a child's included) cleared them for every parent.
// A9  — the bin DELETEd the row the generator's dedupe is built from, so the
//       next scan re-created it and delivered it again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, role: 'child', userId: 'u-kid' }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: h.userId }, memberships: [],
    active: { familyId: 'fam-1', role: h.role, member: { id: 'm' }, family: { id: 'fam-1', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/server/push', () => ({ dispatchPendingPushes: async () => ({ notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } }) }));
vi.mock('@/lib/services/tasks', () => ({ respawnMissingChoreAssignments: async () => ({ ok: true, data: { respawned: 0, skipped: 0, failed: 0 } }) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));

const { generateFamilyNotifications } = await import('@/lib/server/notifications');
const { dismissNotificationAction } = await import('@/app/(app)/dashboard/notifications/actions');
const { GET: pushScan } = await import('@/app/api/cron/push-scan/route');
const { POST: scan } = await import('@/app/api/notifications/generate/route');

type DB = SupabaseClient<Database>;
const FAMILY = 'fam-1';
const NOW = new Date('2026-09-30T12:00:00.000Z');
let db: InMemorySupabase;

const REFUSED = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null }, count: null, status: 500, statusText: 'Error' };
/** The same database, with the calls `refuse` names answering an error. */
function refusing(base: InMemorySupabase, refuse: (table: string, calls: string[]) => boolean): InMemorySupabase {
  return new Proxy(base, { get(target, key) {
    if (key !== 'from') return Reflect.get(target, key);
    return (table: string) => {
      const builder = target.from(table) as unknown as Record<string | symbol, unknown> & PromiseLike<unknown>;
      const calls: string[] = [];
      const proxy: object = new Proxy(builder, { get(object, k) {
        if (k === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => (refuse(table, calls) ? Promise.resolve(REFUSED).then(res, rej) : object.then(res, rej));
        const value = Reflect.get(object, k);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(String(k));
          if ((k === 'maybeSingle' || k === 'single') && refuse(table, calls)) return Promise.resolve(REFUSED);
          const result = Reflect.apply(value, object, args);
          return result === object ? proxy : result;
        };
      } });
      return proxy;
    };
  } });
}

const MED = { id: 'med-1', family_id: FAMILY, name: 'Amoxicillin', dosage: '5 ml', member_id: null, is_active: true };
const SCHEDULE = { id: 'sch-1', family_id: FAMILY, medication_id: 'med-1', time_of_day: '08:00:00', days_of_week: [0, 1, 2, 3, 4, 5, 6], starts_on: '2026-01-01', ends_on: null };
const TAKEN = { schedule_id: 'sch-1', family_id: FAMILY, scheduled_for: '2026-09-30T08:00:00.000Z', status: 'taken' };
const event = (row: Record<string, unknown>) => ({
  family_id: FAMILY, description: null, location: null, category: 'general', all_day: false, recurrence: 'none', recurrence_until: null,
  assignee_id: null, feed_id: null, external_uid: null, created_by: 'u-parent', onboarding_key: null,
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', ...row,
});

function household() {
  db = createInMemorySupabase({ defaults: { notifications: { is_read: false, sent_at: null, pushed_at: null } } });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC', closed_at: null }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: FAMILY, user_id: 'u-parent', role: 'parent', is_active: true, display_name: 'Ada', birthday: null },
    { id: 'm-adult', family_id: FAMILY, user_id: 'u-adult', role: 'adult', is_active: true, display_name: 'Ben', birthday: null },
    { id: 'm-kid', family_id: FAMILY, user_id: 'u-kid', role: 'child', is_active: true, display_name: 'Cy', birthday: null },
    { id: 'm-baby', family_id: FAMILY, user_id: null, role: 'child', is_active: true, display_name: 'Dot', birthday: null },
  ]);
  h.db = db;
  return db;
}
const notices = (type?: string) => db.table('notifications').filter((n) => !type || n.type === type);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.role = 'child'; h.userId = 'u-kid';
  household();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('medication reminders are not built from reads that failed (A3)', () => {
  beforeEach(() => {
    db.seed('medications', [MED]);
    db.seed('medication_schedules', [SCHEDULE]);
  });

  it('a dose log that could not be read reminds nobody of a dose already given, and says so', async () => {
    db.seed('medication_doses', [TAKEN]);
    const report = { failedSources: [] as string[] };
    await generateFamilyNotifications(refusing(db, (t) => t === 'medication_doses') as unknown as DB, FAMILY, report);
    expect(notices('medication_due')).toEqual([]);
    expect(report.failedSources).toContain('medication_doses');
  });

  it('a dose taken today, read, is not reminded either (control)', async () => {
    db.seed('medication_doses', [TAKEN]);
    expect(await generateFamilyNotifications(db as unknown as DB, FAMILY)).toBe(0);
  });

  it('a dedupe read that failed does not send today\'s reminder a second time', async () => {
    // Already reminded today, dose still outstanding.
    db.seed('notifications', ['u-parent', 'u-adult'].map((user) => ({
      family_id: FAMILY, user_id: user, type: 'medication_due', title: 'Medication due: Amoxicillin', body: 'x',
      related_type: 'medications', related_id: 'med-1', send_at: '2026-09-30T07:00:00.000Z', created_at: '2026-09-30T07:00:00.000Z',
    })));
    const report = { failedSources: [] as string[] };
    const created = await generateFamilyNotifications(
      refusing(db, (t, calls) => t === 'notifications' && calls.includes('gte') && !calls.includes('insert')) as unknown as DB, FAMILY, report);
    expect(created).toBe(0);
    expect(notices('medication_due')).toHaveLength(2);
    expect(report.failedSources).toContain('notifications_medication_dedupe');
  });

  it('a readable dedupe still reminds the managers once (control)', async () => {
    expect(await generateFamilyNotifications(db as unknown as DB, FAMILY)).toBe(2);
    expect(await generateFamilyNotifications(db as unknown as DB, FAMILY)).toBe(0);
    expect(notices('medication_due').map((n) => n.user_id).sort()).toEqual(['u-adult', 'u-parent']);
  });
});

describe('a read that failed is reported, not read as a quiet family (A15)', () => {
  it('a chore title that could not be read is not written as "Chore due: Task", and is reported', async () => {
    db.seed('chores', [{ id: 'ch-1', family_id: FAMILY, title: 'Feed the cat' }]);
    db.seed('chore_assignments', [{ id: 'ca-1', family_id: FAMILY, chore_id: 'ch-1', member_id: 'm-kid', status: 'todo', due_at: '2026-09-30T15:00:00.000Z' }]);
    const report = { failedSources: [] as string[] };
    await generateFamilyNotifications(refusing(db, (t) => t === 'chores') as unknown as DB, FAMILY, report);
    expect(notices('chore_due')).toEqual([]);
    expect(report.failedSources).toEqual(['chores']);
    // Next tick, readable: the real title, once.
    await generateFamilyNotifications(db as unknown as DB, FAMILY);
    expect(notices('chore_due').map((n) => n.title)).toEqual(['Chore due: Feed the cat']);
  });

  it.each(['family_reminders', 'family_photos', 'relationship_dates', 'documents'])('a failed %s read is reported', async (table) => {
    const report = { failedSources: [] as string[] };
    await generateFamilyNotifications(refusing(db, (t) => t === table) as unknown as DB, FAMILY, report);
    expect(report.failedSources).toEqual([table]);
  });

  it('a family whose reads all answered reports nothing (control)', async () => {
    const report = { failedSources: [] as string[] };
    await generateFamilyNotifications(db as unknown as DB, FAMILY, report);
    expect(report.failedSources).toEqual([]);
  });

  it('the push-scan cron answers 502, not 200 ok, for a tick whose reads failed', async () => {
    h.db = refusing(db, (t) => t === 'family_reminders');
    const res = await pushScan(new Request('https://bubaly.test/api/cron/push-scan') as never);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, failed: 1 });
    h.db = db;
    expect((await pushScan(new Request('https://bubaly.test/api/cron/push-scan') as never)).status).toBe(200);
  });

  it('the Scan route says the scan was incomplete, so the screen does not say "all caught up"', async () => {
    h.db = refusing(db, (t) => t === 'family_photos');
    expect(await (await scan()).json()).toEqual({ created: 0, incomplete: true });
    h.db = db;
    expect(await (await scan()).json()).toEqual({ created: 0, incomplete: false });
  });
});

describe('a family-wide notice is one row per member (A19)', () => {
  beforeEach(() => {
    db.seed('calendar_events', [event({ id: 'ev-1', title: 'Swim gala', starts_at: '2026-09-30T18:00:00.000Z', ends_at: '2026-09-30T19:00:00.000Z' })]);
  });

  it('an unassigned event is written once for each member with a login, settled for email', async () => {
    await generateFamilyNotifications(db as unknown as DB, FAMILY);
    const gala = notices('calendar_event');
    expect(gala.map((n) => n.user_id).sort()).toEqual(['u-adult', 'u-kid', 'u-parent']);
    expect(gala.every((n) => typeof n.sent_at === 'string' && n.pushed_at == null)).toBe(true);
    // So a child reading theirs leaves the parents' unread.
    Object.assign(gala.find((n) => n.user_id === 'u-kid')!, { is_read: true });
    expect(notices('calendar_event').filter((n) => !n.is_read).map((n) => n.user_id).sort()).toEqual(['u-adult', 'u-parent']);
    // And the next tick adds nothing.
    expect(await generateFamilyNotifications(db as unknown as DB, FAMILY)).toBe(0);
  });

  it('a shared row written before the change still covers everyone: no copies are added (control)', async () => {
    db.seed('notifications', [{ family_id: FAMILY, user_id: null, type: 'calendar_event', title: 'Swim gala', body: 'x', related_type: 'calendar_events', related_id: 'ev-1', send_at: '2026-09-30T06:00:00.000Z' }]);
    await generateFamilyNotifications(db as unknown as DB, FAMILY);
    expect(notices('calendar_event')).toHaveLength(1);
  });
});

describe('a dismissed notification stays dismissed (A9)', () => {
  beforeEach(async () => {
    db.seed('calendar_events', [event({ id: 'ev-1', title: 'Swim gala', starts_at: '2026-09-30T18:00:00.000Z', ends_at: '2026-09-30T19:00:00.000Z' })]);
    await generateFamilyNotifications(db as unknown as DB, FAMILY);
  });
  const mine = (user: string) => notices('calendar_event').filter((n) => n.user_id === user);

  it('the bin hides it from every surface and delivery, and the next scan does not bring it back', async () => {
    const row = mine('u-kid')[0];
    expect(await dismissNotificationAction({ id: row.id as string })).toEqual({ ok: true });
    expect(mine('u-kid')).toHaveLength(1);
    expect(mine('u-kid')[0]).toMatchObject({ is_read: true, send_at: '9999-12-31T00:00:00.000Z' });
    expect(typeof mine('u-kid')[0].pushed_at).toBe('string');
    expect(await generateFamilyNotifications(db as unknown as DB, FAMILY)).toBe(0);
    expect(mine('u-kid')).toHaveLength(1);
    // Nobody else's copy moved.
    expect(mine('u-parent')[0]).toMatchObject({ is_read: false, send_at: expect.not.stringMatching(/^9999/) });
  });

  it('a member cannot dismiss someone else\'s notice, and a child cannot dismiss a shared family-wide one', async () => {
    expect((await dismissNotificationAction({ id: mine('u-parent')[0].id as string })).ok).toBe(false);
    db.seed('notifications', [{ id: 'legacy', family_id: FAMILY, user_id: null, type: 'system', title: 'Old shared', body: null, related_type: null, related_id: null, send_at: '2026-09-30T06:00:00.000Z' }]);
    expect((await dismissNotificationAction({ id: 'legacy' })).ok).toBe(false);
    expect(db.table('notifications').find((n) => n.id === 'legacy')).toMatchObject({ is_read: false, send_at: '2026-09-30T06:00:00.000Z' });
    h.role = 'parent'; h.userId = 'u-parent';
    expect(await dismissNotificationAction({ id: 'legacy' })).toEqual({ ok: true });
  });
});
