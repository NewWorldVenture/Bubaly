import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { completeReminder, snoozeReminder } from '@/lib/services/reminders';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A RECURRING FAMILY REMINDER REMINDED ONCE, EVER. A SNOOZED ONE NEVER CAME BACK.
 *
 * `lib/server/notifications.ts` dedupes a family reminder PERMANENTLY on its
 * `related_id`, and that id was `fr:<reminder id>` — the row, not the
 * occurrence. A recurring reminder is one row: `completeReminder` rolls its
 * `remind_at` forward and keeps it active (lib/services/reminders/index.ts), so
 * the second occurrence carried the same key as the first and the dedupe read
 * swallowed it, and every one after it. A daily medication reminder reminded
 * on day one and never again. Snoozed rows were not read at all (`status =
 * 'active'`), so "remind me in two hours" was a promise nothing kept.
 *
 * The fix gives each notice a key that names the occurrence
 * (lib/reminders/notify.ts) and reads snoozed rows by the time they come back.
 * This file runs the REAL engine over the in-memory Supabase, with the real
 * service rolling the reminder forward between ticks, so the thing proved is
 * the household's experience and not the shape of a key.
 */

type DB = SupabaseClient<Database>;
const FAMILY = 'fam-rem';
const DAY1 = '2026-10-05T08:00:00.000Z';
const DAY2 = '2026-10-06T08:00:00.000Z';

let db: ReturnType<typeof createInMemorySupabase<DB>>;

const scope = (): ServiceScope => ({
  db: db as unknown as DB, familyId: FAMILY, userId: 'u-parent', memberId: 'm-parent',
  role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date(),
});
const reminderNotices = () => db.table('notifications')
  .filter((n) => n.related_type === 'family_reminders')
  .map((n) => ({ key: n.related_id as string, body: n.body as string, user_id: n.user_id as string | null }));
const generate = () => generateFamilyNotifications(db as unknown as DB, FAMILY);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(DAY1);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<DB>();
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: FAMILY, user_id: 'u-parent', role: 'parent', is_active: true, display_name: 'Parent', birthday: null },
  ]);
  db.seed('family_reminders', [
    { id: 'rem-daily', family_id: FAMILY, title: 'Evening medication', remind_at: '2026-10-05T20:00:00.000Z', status: 'active', recurrence: 'daily', early_reminder_minutes: 0, member_id: 'm-parent', snoozed_until: null },
    { id: 'rem-once', family_id: FAMILY, title: 'Return the library books', remind_at: '2026-10-05T18:00:00.000Z', status: 'active', recurrence: 'none', early_reminder_minutes: null, member_id: null, snoozed_until: null },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a recurring family reminder reminds every time', () => {
  it('reminds on day one, and again on day two after the row has rolled forward', async () => {
    expect(await generate()).toBe(2);
    expect(reminderNotices()).toEqual([
      { key: 'fr:rem-daily:2026-10-05T20:00:00.000Z', body: 'Due today at 8:00 PM', user_id: 'u-parent' },
      { key: 'fr:rem-once', body: 'Due today at 6:00 PM', user_id: null },
    ]);
    // The same tick again writes nothing: the dedupe still holds within an occurrence.
    expect(await generate()).toBe(0);

    // The parent ticks the medication off. The REAL service rolls the one row
    // to tomorrow and keeps it active — the reminder's whole point.
    const done = await completeReminder(scope(), 'rem-daily');
    expect(done.ok).toBe(true);
    expect(db.table('family_reminders').find((r) => r.id === 'rem-daily'))
      .toMatchObject({ status: 'active', remind_at: '2026-10-06T20:00:00.000Z' });

    vi.setSystemTime(DAY2);
    expect(await generate(), 'day two is a new notice, not a duplicate of day one').toBe(1);
    expect(reminderNotices().map((n) => n.key)).toEqual([
      'fr:rem-daily:2026-10-05T20:00:00.000Z',
      'fr:rem-once',
      'fr:rem-daily:2026-10-06T20:00:00.000Z',
    ]);
    expect(reminderNotices().at(-1)?.body).toBe('Due today at 8:00 PM');
    expect(await generate()).toBe(0);
  });

  it('a snoozed reminder comes back at snoozed_until, even though it was already notified once', async () => {
    expect(await generate()).toBe(2);
    // "Remind me in two hours" at 08:00 → back at 10:00.
    const snoozed = await snoozeReminder(scope(), 'rem-once', 120);
    expect(snoozed.ok).toBe(true);
    expect(db.table('family_reminders').find((r) => r.id === 'rem-once'))
      .toMatchObject({ status: 'snoozed', snoozed_until: '2026-10-05T10:00:00.000Z' });

    expect(await generate(), 'the snooze is a new notice').toBe(1);
    expect(reminderNotices().at(-1)).toEqual({ key: 'fr:rem-once:snoozed:2026-10-05T10:00:00.000Z', body: 'Due today at 10:00 AM', user_id: null });
    expect(await generate()).toBe(0);
  });

  it('a one-off keeps the key it always had, and a completed reminder is never notified', async () => {
    const done = await completeReminder(scope(), 'rem-once');
    expect(done.ok).toBe(true);
    expect(db.table('family_reminders').find((r) => r.id === 'rem-once')).toMatchObject({ status: 'completed' });
    expect(await generate()).toBe(1);
    expect(reminderNotices().map((n) => n.key)).toEqual(['fr:rem-daily:2026-10-05T20:00:00.000Z']);
  });

  it('a snooze that lands beyond the window waits for it', async () => {
    db.replace('family_reminders', [
      { id: 'rem-far', family_id: FAMILY, title: 'Far snooze', remind_at: '2026-10-05T07:00:00.000Z', status: 'snoozed', recurrence: 'none', early_reminder_minutes: null, member_id: null, snoozed_until: '2026-10-07T07:00:00.000Z' },
    ]);
    expect(await generate()).toBe(0);
    vi.setSystemTime(DAY2);
    expect(await generate()).toBe(1);
    expect(reminderNotices().map((n) => n.key)).toEqual(['fr:rem-far:snoozed:2026-10-07T07:00:00.000Z']);
  });
});
