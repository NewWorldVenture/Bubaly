// An item read about the morning after it was due is told "Overdue" once.
//
// /api/cron/return-reminders words each notice for the morning it is read
// (tests/a-return-reminder-is-worded-for-the-morning-it-is-read.test.ts). In a
// zone whose quiet hours hold the 08:00 UTC tick to the next local morning
// (21:00 in Auckland), an item first nudged on its own due day is read the day
// after, so the due nudge says "Overdue: … was due 1 day ago". It spent only
// the due nudge's stamp, though, and on the next tick the overdue alert found
// its own stamp unset and said "Overdue: … was due 2 days ago" as well: two
// Overdue notices on consecutive mornings. The late nudge now takes the overdue
// stamp too, hands both back if it could not be sent, and is not sent at all
// when that stamp is already taken (a refused claim still sends, and fails the
// run). Driven through the real route, the real notify() and the real quiet
// hours against the in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));

const { GET } = await import('@/app/api/cron/return-reminders/route');

const FAMILY = 'fam-1';
const ORDER = 'order-1';
const PARENT = { id: 'm-1', family_id: FAMILY, user_id: 'u-1', role: 'parent', is_active: true };
// Friday 23 October 2026 in Auckland: due today at the 08:00 UTC tick (21:00 NZDT).
const DUE = '2026-10-23';
const FIRST_TICK = new Date('2026-10-23T08:00:00.000Z');
const NEXT_TICK = new Date('2026-10-24T08:00:00.000Z');
let db: InMemorySupabase;
const req = () => new Request('https://bubaly.test/api/cron/return-reminders') as never;
const order = () => db.table('marketplace_orders').find((o) => o.id === ORDER)!;
const notices = () => db.table('notifications').filter((n) => String(n.related_id).startsWith(ORDER));
const overdueNotices = () => notices().filter((n) => String(n.title).startsWith('Overdue'));

type Then = (ok?: (value: unknown) => unknown, ko?: (reason: unknown) => unknown) => Promise<unknown>;
/** The database, with the first claim of an overdue stamp refused (a statement timeout); nothing else changed. */
function refusingTheOverdueClaim(target: InMemorySupabase): unknown {
  let refused = false;
  return new Proxy(target as object, {
    get(base, prop, receiver) {
      if (prop !== 'from') return Reflect.get(base, prop, receiver);
      return (name: string) => {
        const builder = (base as InMemorySupabase).from(name as never) as unknown as { update: (...args: unknown[]) => { then: Then } };
        if (name !== 'marketplace_orders') return builder;
        const update = builder.update.bind(builder);
        builder.update = (...args: unknown[]) => {
          const chain = update(...args);
          if (refused || !(args[0] as { overdue_notified_at?: unknown }).overdue_notified_at) return chain;
          refused = true;
          const reply = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, count: null, status: 500, statusText: 'Internal Server Error' };
          chain.then = (ok, ko) => Promise.resolve(reply).then(ok, ko);
          return chain;
        };
        return builder;
      };
    },
  });
}

async function tick(at: Date) {
  vi.setSystemTime(at);
  return (await GET(req())).json();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ defaults: { notifications: { is_read: false, sent_at: null, pushed_at: null } } });
  h.db = db;
  db.seed('families', [{ id: FAMILY, timezone: 'Pacific/Auckland', closed_at: null }]);
  // The suggested window from the settings page: 21:00 to 07:00.
  db.seed('family_ai_settings', [{ family_id: FAMILY, quiet_hours_start: 21, quiet_hours_end: 7 }]);
  db.seed('marketplace_listings', [{ id: 'listing-1', title: 'The ladder' }]);
  db.seed('marketplace_orders', [{
    id: ORDER, family_id: FAMILY, listing_id: 'listing-1', buyer_member: 'm-1', kind: 'borrow', status: 'active',
    ends_on: DUE, due_reminder_sent_at: null, overdue_notified_at: null, returned_at: null,
  }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a due nudge read the morning after its due day', () => {
  it('is the overdue alert: the next tick does not say "Overdue" again', async () => {
    db.seed('family_members', [PARENT]);
    expect(await tick(FIRST_TICK)).toMatchObject({ ok: true, reminded: 1, failed: 0 });
    expect(overdueNotices()).toHaveLength(1);
    expect(overdueNotices()[0].body).toBe('This borrowed item was due 1 day ago. Arrange the return so it doesn\'t hold anyone up.');

    const next = await tick(NEXT_TICK);
    // The defect: a second notice, "Overdue: … was due 2 days ago", the next morning.
    expect(overdueNotices(), 'told "Overdue" two mornings running').toHaveLength(1);
    expect(next).toMatchObject({ ok: true, reminded: 0, overdue: 0, failed: 0 });
    // Both said by the one notice, both stamped by the tick that sent it.
    expect(order()).toMatchObject({ due_reminder_sent_at: FIRST_TICK.toISOString(), overdue_notified_at: FIRST_TICK.toISOString() });
  });

  it('that could not be sent hands both stamps back, and the next tick sends the overdue alert once', async () => {
    // Nobody to tell yet: the send reaches no one.
    const first = await tick(FIRST_TICK);
    expect(first).toMatchObject({ ok: false, reminded: 0, failed: 1 });
    expect(notices()).toEqual([]);
    expect(order()).toMatchObject({ due_reminder_sent_at: null, overdue_notified_at: null });

    db.seed('family_members', [PARENT]);
    expect(await tick(NEXT_TICK)).toMatchObject({ ok: true, overdue: 1, failed: 0 });
    expect(overdueNotices()).toEqual([expect.objectContaining({ related_id: `${ORDER}:overdue` })]);
    expect(order().overdue_notified_at).toBe(NEXT_TICK.toISOString());
  });

  it('whose overdue stamp could not be claimed is still sent, and the run says it failed', async () => {
    db.seed('family_members', [PARENT]);
    h.db = refusingTheOverdueClaim(db);
    expect(await tick(FIRST_TICK)).toMatchObject({ ok: false, reminded: 1, failed: 1 });
    // A refused claim may have landed with its answer lost: holding the nudge
    // back on it could leave the only notice unsaid.
    expect(overdueNotices()).toHaveLength(1);
    expect(order()).toMatchObject({ due_reminder_sent_at: FIRST_TICK.toISOString(), overdue_notified_at: null });
  });

  it('whose overdue alert another run already holds is not sent as a second "Overdue"', async () => {
    db.seed('family_members', [PARENT]);
    const held = '2026-10-23T07:59:00.000Z';
    db.replace('marketplace_orders', [{ ...order(), overdue_notified_at: held }]);
    expect(await tick(FIRST_TICK)).toMatchObject({ ok: true, reminded: 0, failed: 0 });
    expect(overdueNotices()).toEqual([]);
    // The holder's stamp is left as it was, and the nudge it stands for is spent.
    expect(order()).toMatchObject({ due_reminder_sent_at: FIRST_TICK.toISOString(), overdue_notified_at: held });
  });
});

describe('a due nudge read on a day it is not yet late (control)', () => {
  it('leaves the overdue stamp for the overdue alert', async () => {
    db.seed('family_members', [PARENT]);
    db.replace('family_ai_settings', []);
    // No quiet hours: read at the tick, on the due day itself.
    expect(await tick(FIRST_TICK)).toMatchObject({ ok: true, reminded: 1 });
    expect(notices()[0].title).toBe('Due today: "The ladder"');
    expect(order().overdue_notified_at).toBeNull();
  });
});
