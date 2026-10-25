// A return reminder says what is true on the morning it is read.
//
// /api/cron/return-reminders runs at 08:00 UTC and worded every notice from the
// family's day at that instant: "Due today", "Due in 1 day", "was due 2 days
// ago". notify() then holds a courtesy notice past the family's quiet hours,
// and for a window that crosses midnight the 08:00 UTC tick lands in its
// evening part: 21:00 in Auckland (NZDT), 22:00 the evening before in Honolulu.
// The notice reached the bell and the phone the next local morning, a day off:
// "Due in 1 day" on the day it was due, "Due today" the morning after.
//
// The words are now the reading day's (deliveryTimeFor, the same function
// notify() stamps send_at with), while whether to send stays the family's day.
// Driven through the real route, the real notify() and the real quiet hours
// against the in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));

const { GET } = await import('@/app/api/cron/return-reminders/route');

const FAMILY = 'fam-1';
const ORDER = 'order-1';
// Friday 23 October 2026, 08:00 UTC: the route's '0 8 * * *' tick.
const NOW = new Date('2026-10-23T08:00:00.000Z');
let db: InMemorySupabase;
const req = () => new Request('https://bubaly.test/api/cron/return-reminders') as never;
const order = () => db.table('marketplace_orders').find((o) => o.id === ORDER)!;
const notices = () => db.table('notifications').filter((n) => String(n.related_id).startsWith(ORDER));

function seed(timezone: string, endsOn: string, opts: { quiet?: boolean; nudged?: boolean } = {}) {
  db.seed('families', [{ id: FAMILY, timezone, closed_at: null }]);
  db.seed('family_members', [{ id: 'm-1', family_id: FAMILY, user_id: 'u-1', role: 'parent', is_active: true }]);
  // The suggested window from the settings page: 21:00 to 07:00.
  if (opts.quiet !== false) db.seed('family_ai_settings', [{ family_id: FAMILY, quiet_hours_start: 21, quiet_hours_end: 7 }]);
  db.seed('marketplace_listings', [{ id: 'listing-1', title: 'The ladder' }]);
  db.seed('marketplace_orders', [{
    id: ORDER, family_id: FAMILY, listing_id: 'listing-1', buyer_member: 'm-1', kind: 'borrow', status: 'active',
    ends_on: endsOn, due_reminder_sent_at: opts.nudged ? '2026-10-19T08:00:00.000Z' : null, overdue_notified_at: null, returned_at: null,
  }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ defaults: { notifications: { is_read: false, sent_at: null, pushed_at: null } } });
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a reminder held past quiet hours until the next morning', () => {
  // [zone, the local day at the tick, the morning it is read, the read instant]
  it.each([
    ['Pacific/Auckland', '2026-10-23', '2026-10-24', '2026-10-23T18:00:00.000Z'],
    ['Pacific/Honolulu', '2026-10-22', '2026-10-23', '2026-10-23T17:00:00.000Z'],
  ])('in %s, an item due the morning it is read says "Due today"', async (tz, tickDay, readDay, readAt) => {
    seed(tz, readDay);
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ ok: true, reminded: 1, overdue: 0, failed: 0 });
    // Held to the morning, as before: the deferral is notify()'s and unchanged.
    expect(notices()).toHaveLength(1);
    expect(notices()[0].send_at).toBe(readAt);
    expect(notices()[0].title, `worded from the tick's day (${tickDay}): "Due in 1 day" on the day it is due`).toBe('Due today: "The ladder"');
    expect(order().due_reminder_sent_at).toBe(NOW.toISOString());
  });

  it('an item due on the tick\'s own day is read the morning after, and says it is overdue', async () => {
    seed('Pacific/Auckland', '2026-10-23');
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ ok: true, reminded: 1, failed: 0 });
    expect(notices()[0]).toMatchObject({ title: 'Overdue: "The ladder"', related_id: `${ORDER}:due` });
    expect(notices()[0].body).toBe('This borrowed item was due 1 day ago. Arrange the return so it doesn\'t hold anyone up.');
  });

  it('an overdue alert counts the days to the morning it is read', async () => {
    seed('Pacific/Auckland', '2026-10-21', { nudged: true });
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ ok: true, overdue: 1, failed: 0 });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ title: 'Overdue: "The ladder"', related_id: `${ORDER}:overdue`, send_at: '2026-10-23T18:00:00.000Z' });
    expect(notices()[0].body, 'counted from the tick\'s day: "2 days" read on the third').toBe('This borrowed item was due 3 days ago. Arrange the return so it doesn\'t hold anyone up.');
  });
});

describe('a reminder delivered at once (control)', () => {
  it('keeps the tick\'s day when nothing holds it: no quiet hours', async () => {
    seed('Pacific/Auckland', '2026-10-24', { quiet: false });
    await GET(req());
    expect(notices()[0]).toMatchObject({ title: 'Due in 1 day: "The ladder"', send_at: NOW.toISOString() });
  });

  it('keeps the tick\'s day when the window does not cross into the next day: London at 09:00', async () => {
    seed('Europe/London', '2026-10-24');
    await GET(req());
    expect(notices()[0]).toMatchObject({ title: 'Due in 1 day: "The ladder"', send_at: NOW.toISOString() });
  });
});
