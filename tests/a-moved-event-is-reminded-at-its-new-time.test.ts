import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

/**
 * AN EVENT MOVED TO A LATER DAY IS REMINDED AT ITS NEW TIME.
 *
 * The notification engine reminds each event in the next 48 hours, and its
 * dedupe is permanent and keyed by `related_id`. A series occurrence's key
 * carries its date. A one-off's key is the bare event id, so once the family
 * had been reminded about it, it never was again, wherever it moved. Saturday's
 * game, rained out and moved to next Saturday, got Thursday's reminder for the
 * first date and nothing for the second.
 *
 * The key stays the bare id, so no new keys appear at deploy and nothing is
 * reminded twice. For a one-off, an earlier notice now counts as sent only when
 * it was written inside THIS start's reminder window: 48 hours before the start
 * (before the family's midnight for an all-day date), less an hour for clock
 * skew between the database and the server.
 */

const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const PARENT = '00000000-0000-4000-8000-00000000ad01';
const PARENT_USER = '00000000-0000-4000-8000-00000000aa01';
const GAME = '00000000-0000-4000-8000-0000000000e1';
const NY = 'America/New_York';

const event = (row: Record<string, unknown>) => ({
  family_id: FAMILY, description: null, location: null, category: 'sports', all_day: false,
  recurrence: 'none', recurrence_until: null, assignee_id: PARENT, feed_id: null, external_uid: null,
  created_by: PARENT_USER, onboarding_key: null, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
  ends_at: null, ...row,
});

function household(rows: Record<string, unknown>[], timezone = NY) {
  const db = createInMemorySupabase();
  db.seed('families', [{ id: FAMILY, timezone }]);
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, user_id: PARENT_USER, display_name: 'Dana', role: 'parent', is_active: true, birthday: null },
  ]);
  db.seed('calendar_events', rows.map(event));
  return db;
}

type Notice = { type: string; related_id: string; user_id: string | null; body: string; created_at: string };
const reminders = (db: ReturnType<typeof household>) =>
  (db.table('notifications') as Notice[]).filter((n) => n.type === 'calendar_event' && n.related_id === GAME);

async function tick(db: ReturnType<typeof household>, at: string) {
  vi.setSystemTime(new Date(at));
  await generateFamilyNotifications(db as unknown as SupabaseClient<Database>, FAMILY);
}

function move(db: ReturnType<typeof household>, startsAt: string) {
  db.replace('calendar_events', db.table('calendar_events').map((r) => (r.id === GAME ? { ...r, starts_at: startsAt } : r)));
}

describe('a one-off event moved after its reminder', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a game rained out to next Saturday is reminded again before the new date', async () => {
    // Saturday 17 October, 10:00 EDT.
    const db = household([event({ id: GAME, title: 'Soccer game', starts_at: '2026-10-17T14:00:00.000Z' })]);
    await tick(db, '2026-10-15T15:00:00.000Z'); // Thursday
    expect(reminders(db)).toHaveLength(1);

    move(db, '2026-10-24T14:00:00.000Z'); // Friday: rained out, now Saturday the 24th
    await tick(db, '2026-10-22T15:00:00.000Z'); // the next Thursday

    expect(reminders(db), 'the moved game was taken as already reminded').toHaveLength(2);
    expect(reminders(db)[1]!.body).toBe('Saturday at 10:00 AM');
    expect(reminders(db)[1]!.user_id).toBe(PARENT_USER);

    // And reminded once for the new date, not on every tick after.
    await tick(db, '2026-10-23T15:00:00.000Z');
    expect(reminders(db)).toHaveLength(2);
  });

  it('an event that has not moved is reminded once across its whole window', async () => {
    const db = household([event({ id: GAME, title: 'Soccer game', starts_at: '2026-10-17T14:00:00.000Z' })]);
    await tick(db, '2026-10-15T14:30:00.000Z'); // 47.5h before
    await tick(db, '2026-10-16T14:00:00.000Z');
    await tick(db, '2026-10-17T13:00:00.000Z');
    expect(reminders(db)).toHaveLength(1);
  });

  it('a notice written a minute before the window, on a database clock behind the server, still counts', async () => {
    const db = household([event({ id: GAME, title: 'Soccer game', starts_at: '2026-10-17T14:00:00.000Z' })]);
    db.seed('notifications', [{
      family_id: FAMILY, user_id: PARENT_USER, type: 'calendar_event', related_type: 'calendar_events', related_id: GAME,
      title: 'Soccer game', body: 'Saturday at 10:00 AM', created_at: '2026-10-15T13:59:00.000Z',
    }]);
    await tick(db, '2026-10-15T15:00:00.000Z');
    expect(reminders(db)).toHaveLength(1);
  });

  it('an all-day date far east of Greenwich counts a notice from when its own day came into view', async () => {
    // Auckland is UTC+13 in October: Saturday the 17th starts at 11:00Z on the
    // 16th, so it comes into the 48-hour view at 11:00Z on the 14th, two and a
    // half days before its stored midnight.
    const db = household([event({ id: GAME, title: 'School gala', starts_at: '2026-10-17T00:00:00.000Z', all_day: true })], 'Pacific/Auckland');
    await tick(db, '2026-10-14T12:00:00.000Z');
    await tick(db, '2026-10-15T12:00:00.000Z');
    expect(reminders(db)).toHaveLength(1);
  });
});
