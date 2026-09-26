import { describe, expect, it, vi } from 'vitest';
import { notificationId, pushDispatchDb } from './helpers/push-dispatch-db';
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
  const fixture = pushDispatchDb({
    notifications: rows.map((item, index) => ({ ...item, id: notificationId(index + 1), created_at: NOW.toISOString() })),
    family_members: [], family_ai_settings: [], push_devices: [], user_preferences: [],
  });
  return { db: fixture.db, stamped: fixture.stamps };
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
    expect(stamped.sort()).toEqual([notificationId(1), notificationId(2)]);
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
