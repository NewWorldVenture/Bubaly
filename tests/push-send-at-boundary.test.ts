import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { dispatchPendingPushes } from '@/lib/server/push';

// A scheduled notification must not buzz the phone early.
//
// `notify()` accepts a future `sendAt`, and defers past a recipient's quiet
// hours by moving `send_at` to the end of the window. The AI's own
// `notifications.notify` tool exposes the field as "Earliest delivery, ISO
// 8601". `listUnread` withholds a not-yet-due row and so does the email
// digest — but push selected on `pushed_at` alone, so "remind everyone at 8am
// tomorrow" arrived on the next two-hourly scan, tonight.
//
// This fake is deliberately not the pass-through chain the read-boundary test
// uses: it APPLIES the filters, so the assertion is about which rows come back,
// not about which method names were called.

const NOW = new Date('2026-03-01T22:00:00.000Z');

type Row = {
  id: string; family_id: string; user_id: string | null; title: string; body: string | null;
  related_type: string | null; related_id: string | null; pushed_at: string | null; send_at: string;
};

function familyDb(rows: Row[]) {
  const stamped: string[] = [];
  const filtered = () => {
    let out = rows.slice();
    return {
      state: () => out,
      is: (col: string, val: null) => { out = out.filter((r) => (r as never as Record<string, unknown>)[col] === val); return api; },
      lte: (col: string, val: string) => { out = out.filter((r) => String((r as never as Record<string, unknown>)[col]) <= val); return api; },
      eq: (col: string, val: string) => { out = out.filter((r) => (r as never as Record<string, unknown>)[col] === val); return api; },
    };
  };
  let cur: ReturnType<typeof filtered>;
  const api: Record<string, unknown> = {
    select: () => api,
    is: (c: string, v: null) => cur.is(c, v),
    lte: (c: string, v: string) => cur.lte(c, v),
    eq: (c: string, v: string) => cur.eq(c, v),
    order: () => api,
    limit: () => api,
    then: (onF: (v: unknown) => unknown) => Promise.resolve({ data: cur.state(), error: null }).then(onF),
  };
  const db = {
    from: (table: string) => {
      if (table === 'notifications') {
        cur = filtered();
        return {
          ...api,
          update: () => ({ eq: (_c: string, id: string) => { stamped.push(id); return Promise.resolve({ error: null }); } }),
        };
      }
      // family_members fan-out, family_ai_settings (child_channels) and
      // push_subscriptions: nobody is subscribed and no family has restricted a
      // child's channels, so sendPushToUsers has nothing to deliver and the
      // counts stay at zero.
      //
      // Self-chaining rather than a fixed two-deep shape: `childrenBlockedOn`
      // filters with `.in(...).eq(...).eq(...)`, and a stub whose `in()` returned
      // a Promise had nothing to chain onto. Every builder method returns the
      // builder, and awaiting it yields no rows.
      const empty: Record<string, unknown> = {};
      Object.assign(empty, {
        select: () => empty, eq: () => empty, in: () => empty, is: () => empty,
        limit: () => empty, order: () => empty,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (f: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(f),
      });
      return empty;
    },
  } as unknown as SupabaseClient<Database>;
  return { db, stamped };
}

const row = (id: string, sendAt: string): Row => ({
  id, family_id: 'fam', user_id: 'user-1', title: `notice ${id}`, body: null,
  related_type: null, related_id: null, pushed_at: null, send_at: sendAt,
});

describe('push dispatch honours send_at', () => {
  it('does not push a notification scheduled for tomorrow morning', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tomorrow8am = '2026-03-02T08:00:00.000Z';
    const { db, stamped } = familyDb([row('scheduled', tomorrow8am)]);

    const out = await dispatchPendingPushes(db, { now: NOW });

    expect(out.notifications, 'a not-yet-due notification must not be dispatched').toBe(0);
    // And it must not be stamped: pushed_at is what stops it being pushed
    // *later*, so stamping an undelivered row would drop it permanently.
    expect(stamped).toEqual([]);
    vi.restoreAllMocks();
  });

  it('still pushes everything that is due', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, stamped } = familyDb([
      row('due-now', NOW.toISOString()),
      row('due-earlier', '2026-03-01T09:00:00.000Z'),
      row('not-yet', '2026-03-02T08:00:00.000Z'),
    ]);

    const out = await dispatchPendingPushes(db, { now: NOW });

    expect(out.notifications).toBe(2);
    expect(stamped.sort()).toEqual(['due-earlier', 'due-now']);
    vi.restoreAllMocks();
  });

  it('defaults to the real clock when no `now` is supplied', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const farFuture = new Date(Date.now() + 86_400_000).toISOString();
    const longPast = new Date(Date.now() - 86_400_000).toISOString();
    const { db } = familyDb([row('past', longPast), row('future', farFuture)]);

    // No `now` option: the production call site (the cron) passes none.
    const out = await dispatchPendingPushes(db);

    expect(out.notifications).toBe(1);
    vi.restoreAllMocks();
  });
});
