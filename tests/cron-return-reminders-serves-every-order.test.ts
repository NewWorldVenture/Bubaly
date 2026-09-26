// Every borrowed item that is due gets its nudge — not the first two hundred
// rows the database happened to hand back.
//
// The cron read open rent/borrow orders with a bare `.limit(200)` and NO order
// by. `ends_on` is not in the filter either, so the batch is filled with every
// open rent/borrow order in the deployment, most of which are due months from
// now and need nothing. PostgREST's row order without an ORDER BY is arbitrary,
// so which 200 came back was not the cron's decision: past that many open
// orders, an item due today could sit outside the slice on every single run and
// never be nudged, and the run still answered 200 with `ok: true`.
//
// Behavioural, not source text: the order that needs the reminder is the
// 1,051st row, and the assertion is that its family is told.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  orders: [] as Row[],
  notified: [] as { familyId: string; relatedId: string | null; title: string }[],
  /** Every `.order(column)` the orders read asked for, so paging is stable. */
  orderedBy: [] as string[],
  stamps: [] as Row[],
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (k: string) => k }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/services/scope', () => ({
  systemScopeForFamily: async (_db: unknown, familyId: string) => ({ familyId, tz: 'UTC' }),
}));
vi.mock('@/lib/services/notifications', () => ({
  notify: async (scope: { familyId: string }, n: { title: string; relatedId: string | null }) => {
    state.notified.push({ familyId: scope.familyId, relatedId: n.relatedId, title: n.title });
    return { ok: true, data: { created: 1 } };
  },
}));

/** PostgREST's own ceiling: an unbounded select never returns more than this. */
const DB_MAX_ROWS = 1000;

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      let limit: number | null = null;
      let range: { from: number; to: number } | null = null;
      let patch: Row | null = null;
      const rowsFor = () => {
        if (table !== 'marketplace_orders') {
          return [{ id: 'listing-1', title: 'The ladder' }];
        }
        const all = state.orders;
        const slice = range ? all.slice(range.from, range.to + 1) : all.slice(0, limit ?? all.length);
        return slice.slice(0, DB_MAX_ROWS);
      };
      const b: Row = {};
      Object.assign(b, {
        select: () => b,
        in: () => b,
        not: () => b,
        order: (c: string) => { if (table === 'marketplace_orders') state.orderedBy.push(c); return b; },
        limit: (n: number) => { limit = n; return b; },
        range: (from: number, to: number) => { range = { from, to }; return b; },
        update: (p: Row) => { patch = p; return b; },
        eq: (_c: string, v: unknown) => {
          state.stamps.push({ id: v, ...(patch ?? {}) });
          return Promise.resolve({ error: null });
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: rowsFor(), error: null }),
      });
      return b;
    },
  }),
}));

const { GET } = await import('@/app/api/cron/return-reminders/route');
const req = () => new Request('https://bubaly.test/api/cron/return-reminders') as never;

// A fixed morning, so "due today" is a fact rather than a question about when
// the suite happens to run.
const FROZEN_NOW = new Date('2026-09-19T08:00:00.000Z');

/** One open borrow order. `ends_on` decides whether it needs anything. */
const order = (i: number, endsOn: string): Row => ({
  id: `order-${i}`, family_id: `fam-${i}`, listing_id: 'listing-1', buyer_member: 'mem-1',
  kind: 'borrow', status: 'confirmed', ends_on: endsOn,
  due_reminder_sent_at: null, overdue_notified_at: null, returned_at: null,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FROZEN_NOW);
  state.notified = [];
  state.orderedBy = [];
  state.stamps = [];
  // 1,100 open borrows. All but one are due next year and need nothing; the
  // 1,051st is due today. A cron that reads only a prefix never sees it.
  state.orders = Array.from({ length: 1100 }, (_, i) => order(i, '2027-01-01'));
  state.orders[1050] = order(1050, '2026-09-19');
});

afterEach(() => { vi.useRealTimers(); });

describe('return reminders reach every due order', () => {
  it('nudges an order that sits past the first page of open orders', async () => {
    const res = await GET(req());
    const body = await res.json();

    expect(
      state.notified.map((n) => n.relatedId),
      'the order due today was never looked at, and the run reported itself clean',
    ).toEqual(['order-1050']);
    expect(body).toMatchObject({ ok: true, reminded: 1, overdue: 0, failed: 0 });
    expect(res.status).toBe(200);
    // Only the order that was told gets its dedupe stamp.
    expect(state.stamps).toEqual([{ id: 'order-1050', due_reminder_sent_at: FROZEN_NOW.toISOString() }]);
  });

  it('reads the orders in a stable order, so paging cannot skip or repeat one', async () => {
    await GET(req());
    expect(state.orderedBy.length, 'an unordered paged read can skip rows between pages').toBeGreaterThan(0);
    expect(state.orderedBy[0], 'the most urgent order must be read first').toBe('ends_on');
  });
});
