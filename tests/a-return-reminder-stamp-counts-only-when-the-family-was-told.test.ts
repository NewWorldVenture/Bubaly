// household-roles round 10 (R9-RV4-RETURN-REMINDER-STAMPS-HAVE-A-CODE-FIX-IN-BOUNDS):
// a return-reminder stamp counts only when the lender's family was told.
//
// /api/cron/return-reminders sends each borrow or rental one due-soon nudge
// and one overdue alert, and keeps itself from saying either twice with two
// stamps on the order (due_reminder_sent_at, overdue_notified_at). Either
// party of the order may update it (0483's marketplace_orders_update) and
// 0433's trigger freezes neither stamp, so a borrower could set
// overdue_notified_at ahead of the due day: the cron found it set, took the
// alert as said, and the lender's family was never told the item was late.
//
// A set stamp now stands only when the order's family holds the cron's
// notice for it (whole-family, or addressed to someone other than the two
// parties, or to anyone when the family has nobody else to tell), or while it
// may be another run's claim still being sent. Otherwise the cron takes it
// again, fenced on the value it read, and sends. Driven through the real
// route, the real notify() and the real stamps against the in-memory
// database. The owner SQL recorded for 0433 (freeze both stamps for
// everyone but the service role) is still the clean fix.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));

const { GET } = await import('@/app/api/cron/return-reminders/route');

const LENDER = 'fam-lender';
const BORROWER = 'fam-borrower';
const ORDER = '00000000-0000-4000-8000-0000000e0001';
// The day after the ladder was due back, at the 08:00 UTC tick.
const DUE = '2026-09-18';
const NOW = new Date('2026-09-19T08:00:00.000Z');
/** What the borrower wrote into the stamp, a week before the due day. */
const PLANTED = '2026-09-11T19:42:00.000Z';
let db: InMemorySupabase;
const req = () => new Request('https://bubaly.test/api/cron/return-reminders') as never;
const order = () => db.table('marketplace_orders').find((o) => o.id === ORDER)!;
const lenderNotices = (relatedId: string) => db.table('notifications')
  .filter((n) => n.family_id === LENDER && n.related_id === relatedId).map((n) => n.user_id).sort();
const run = async (at: Date) => { vi.setSystemTime(at); return (await GET(req())).json(); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ defaults: { notifications: { is_read: false, sent_at: null, pushed_at: null } } });
  h.db = db;
  db.seed('families', [{ id: LENDER, timezone: 'UTC', closed_at: null }, { id: BORROWER, timezone: 'UTC', closed_at: null }]);
  db.seed('family_members', [
    // The lender's family: the member who listed the ladder, and their partner.
    { id: 'm-seller', family_id: LENDER, user_id: 'u-seller', role: 'parent', is_active: true },
    { id: 'm-partner', family_id: LENDER, user_id: 'u-partner', role: 'adult', is_active: true },
    // The neighbour who borrowed it.
    { id: 'm-borrower', family_id: BORROWER, user_id: 'u-borrower', role: 'parent', is_active: true },
  ]);
  db.seed('marketplace_listings', [{ id: 'listing-1', family_id: LENDER, title: 'The ladder' }]);
  db.seed('marketplace_orders', [{
    id: ORDER, family_id: LENDER, buyer_family_id: BORROWER, listing_id: 'listing-1',
    buyer_member: 'm-borrower', seller_member: 'm-seller', kind: 'borrow', status: 'active',
    ends_on: DUE, due_reminder_sent_at: null, overdue_notified_at: null, returned_at: null,
  }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a stamp the borrower wrote', () => {
  it('ahead of the due day does not stop the lender\'s family being told the item is overdue', async () => {
    // The due nudge went out for real two days before; the borrower then
    // stamped the overdue alert as said, and filed a notice of their own,
    // under the alert's identity, in their own family (all they can file).
    db.table('marketplace_orders')[0].due_reminder_sent_at = '2026-09-16T08:00:00.000Z';
    db.seed('notifications', ['u-seller', 'u-partner'].map((userId) => ({
      family_id: LENDER, user_id: userId, type: 'system', title: 'Due in 2 days: "The ladder"', body: null,
      related_type: 'marketplace_orders', related_id: `${ORDER}:due`, created_at: '2026-09-16T08:00:01.000Z',
    })));
    db.seed('notifications', [{
      family_id: BORROWER, user_id: 'u-borrower', type: 'system', title: 'Overdue: "The ladder"', body: null,
      related_type: 'marketplace_orders', related_id: `${ORDER}:overdue`,
    }]);
    order().overdue_notified_at = PLANTED;

    expect(await run(NOW)).toMatchObject({ ok: true, overdue: 1, failed: 0 });

    expect(lenderNotices(`${ORDER}:overdue`), 'the stamp the borrower wrote was taken as the alert').toEqual(['u-partner', 'u-seller']);
    // Taken again by the cron, from the value it read.
    expect(order().overdue_notified_at).toBe(NOW.toISOString());
    // Said once: the next morning's tick finds the family told.
    expect(await run(new Date('2026-09-20T08:00:00.000Z'))).toMatchObject({ ok: true, overdue: 0, reminded: 0 });
    expect(lenderNotices(`${ORDER}:overdue`)).toEqual(['u-partner', 'u-seller']);
  });

  it('before the due-soon window does not stop the due nudge', async () => {
    order().due_reminder_sent_at = PLANTED;
    const dueSoon = new Date('2026-09-17T08:00:00.000Z');

    expect(await run(dueSoon)).toMatchObject({ ok: true, reminded: 1, failed: 0 });

    expect(lenderNotices(`${ORDER}:due`)).toEqual(['u-partner', 'u-seller']);
    expect(order().due_reminder_sent_at).toBe(dueSoon.toISOString());
  });
});

describe('a party\'s own notice', () => {
  it('filed beside a stamp does not stand for the alert while the family has someone else to tell', async () => {
    // A party of the order in the lender's family can file a notice addressed
    // to themselves under the alert's identity, and stamp the order.
    db.seed('notifications', [{
      family_id: LENDER, user_id: 'u-seller', type: 'system', title: 'Overdue: "The ladder"', body: null,
      related_type: 'marketplace_orders', related_id: `${ORDER}:overdue`,
    }]);
    order().overdue_notified_at = PLANTED;

    expect(await run(NOW)).toMatchObject({ ok: true, overdue: 1 });

    // The partner is told; the party is not told twice.
    expect(lenderNotices(`${ORDER}:overdue`)).toEqual(['u-partner', 'u-seller']);
  });
});

describe('controls: a stamp the cron wrote still stands', () => {
  it('the cron\'s own overdue alert is not said again on the next tick', async () => {
    expect(await run(NOW)).toMatchObject({ ok: true, overdue: 1 });
    const stamped = order().overdue_notified_at;
    expect(await run(new Date('2026-09-20T08:00:00.000Z'))).toMatchObject({ ok: true, overdue: 0, failed: 0 });
    expect(lenderNotices(`${ORDER}:overdue`)).toEqual(['u-partner', 'u-seller']);
    expect(order().overdue_notified_at).toBe(stamped);
  });

  it('in a family with nobody but the party to tell, the party\'s own row is the cron\'s', async () => {
    db.replace('family_members', db.table('family_members').filter((m) => m.id !== 'm-partner'));
    expect(await run(NOW)).toMatchObject({ ok: true, overdue: 1 });
    const stamped = order().overdue_notified_at;
    expect(await run(new Date('2026-09-20T08:00:00.000Z'))).toMatchObject({ ok: true, overdue: 0, failed: 0 });
    expect(lenderNotices(`${ORDER}:overdue`)).toEqual(['u-seller']);
    // Not taken again every morning.
    expect(order().overdue_notified_at).toBe(stamped);
  });

  it('a stamp another run took a minute ago is that run\'s claim, not a stamp to take again', async () => {
    const held = new Date(NOW.getTime() - 60_000).toISOString();
    order().overdue_notified_at = held;
    expect(await run(NOW)).toMatchObject({ ok: true, overdue: 0, failed: 0 });
    expect(lenderNotices(`${ORDER}:overdue`)).toEqual([]);
    expect(order().overdue_notified_at).toBe(held);
  });
});
