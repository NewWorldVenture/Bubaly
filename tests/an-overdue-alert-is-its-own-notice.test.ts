// The overdue alert is its own notice, and "notified" means delivered.
//
// /api/cron/return-reminders sent the due-soon nudge and, days later, the
// overdue alert through notify() under the SAME type and related_id (the
// order's). notify()'s default guard drops every recipient whose row under
// that identity is still unread, so anyone who had not opened the due-soon
// notice never received the overdue alert — and because notify() answered ok
// with `created: 0`, the route stamped `overdue_notified_at` and counted it
// delivered. Never delivered, never retried. The same shape let an overlapping
// run stamp without sending: the stamp was a receipt, not a claim.
//
// The overdue alert now has its own identity (`<order>:overdue`, said once),
// delivered means a row exists for THAT identity, and the stamp is a
// compare-and-set claim taken before the send and handed back when the send
// did not go out — driven here through the real route and the real notify()
// against the in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));

const { GET } = await import('@/app/api/cron/return-reminders/route');

const FAMILY = 'fam-1';
const ORDER = 'order-1';
const NOW = new Date('2026-09-19T08:00:00.000Z');
let db: InMemorySupabase;
const req = () => new Request('https://bubaly.test/api/cron/return-reminders') as never;
const order = () => db.table('marketplace_orders').find((o) => o.id === ORDER)!;
const overdueNotices = () => db.table('notifications').filter((n) => n.related_id === `${ORDER}:overdue`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ defaults: { notifications: { is_read: false, sent_at: null, pushed_at: null } } });
  h.db = db;
  db.seed('families', [{ id: FAMILY, timezone: 'UTC', closed_at: null }]);
  db.seed('family_members', [
    { id: 'm-1', family_id: FAMILY, user_id: 'u-1', role: 'parent', is_active: true },
    { id: 'm-2', family_id: FAMILY, user_id: 'u-2', role: 'adult', is_active: true },
  ]);
  db.seed('marketplace_listings', [{ id: 'listing-1', title: 'The ladder' }]);
  // Borrowed, due yesterday, nudged two days before it was due.
  db.seed('marketplace_orders', [{
    id: ORDER, family_id: FAMILY, listing_id: 'listing-1', buyer_member: 'm-1', kind: 'borrow', status: 'active',
    ends_on: '2026-09-18', due_reminder_sent_at: '2026-09-16T08:00:00.000Z', overdue_notified_at: null, returned_at: null,
  }]);
  // The due-soon notices, still unread by both members — the way the route
  // used to file them, under the order's own id.
  db.seed('notifications', ['u-1', 'u-2'].map((userId) => ({
    family_id: FAMILY, user_id: userId, type: 'system', title: 'Due in 2 days: "The ladder"', body: null,
    related_type: 'marketplace_orders', related_id: ORDER, is_read: false,
  })));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('an order going overdue while its due-soon notice is unread', () => {
  it('alerts every member, under the alert\'s own identity, and is stamped', async () => {
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ ok: true, overdue: 1, reminded: 0, failed: 0 });
    expect(res.status).toBe(200);
    expect(overdueNotices().map((n) => n.user_id).sort(), 'the overdue alert was dropped by the due-soon notice\'s dedupe and stamped as sent').toEqual(['u-1', 'u-2']);
    expect(overdueNotices()[0]).toMatchObject({ type: 'system', related_type: 'marketplace_orders', title: 'Overdue: "The ladder"' });
    expect(order().overdue_notified_at).toBe(NOW.toISOString());
  });

  it('is alerted once across two overlapping runs: the stamp is a claim', async () => {
    const [a, b] = await Promise.all([GET(req()), GET(req())]);
    const bodies = await Promise.all([a.json(), b.json()]);
    expect(overdueNotices()).toHaveLength(2);
    expect(bodies.map((body) => body.overdue).sort()).toEqual([0, 1]);
    expect(bodies.map((body) => body.failed)).toEqual([0, 0]);
  });

  it('is not stamped when the alert could not be written: the claim is handed back and the run fails', async () => {
    h.db = withFaults(db, (table, calls) => (
      table === 'notifications' && calls.some((c) => c.method === 'insert')
        ? { code: '57014', message: 'canceling statement due to statement timeout' }
        : null
    ));
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, overdue: 0, failed: 1 });
    expect(order().overdue_notified_at, 'stamped as alerted with nobody told').toBeNull();
    expect(overdueNotices()).toEqual([]);

    // The next run, with the database answering, alerts and stamps.
    h.db = db;
    expect(await (await GET(req())).json()).toMatchObject({ ok: true, overdue: 1 });
    expect(overdueNotices()).toHaveLength(2);
  });
});

describe('the due-soon nudge', () => {
  it('carries its own identity too, so a later overdue alert is never taken for its duplicate', async () => {
    order().due_reminder_sent_at = null;
    order().ends_on = '2026-09-20';
    db.replace('notifications', []);
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ ok: true, reminded: 1, overdue: 0 });
    expect(db.table('notifications').map((n) => n.related_id)).toEqual([`${ORDER}:due`, `${ORDER}:due`]);
    expect(order().due_reminder_sent_at).toBe(NOW.toISOString());
  });
});
