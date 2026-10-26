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
 * A MOVED SCHOOL OR SPORTS EVENT IS REMINDED AT ITS NEW TIME.
 *
 * The same gap tests/a-moved-event-is-reminded-at-its-new-time.test.ts closed
 * for one-off calendar events. `school_events` and `sports_events` reminders are
 * keyed by the bare row id and deduped permanently, so a game moved to next
 * Saturday, or a parent-teacher night pushed back a week, was never reminded
 * at its new date once its first reminder had gone out.
 *
 * Same rule, same keys: an earlier notice counts as sent only when it was
 * written within 48 hours (and an hour of clock skew) before the current start.
 * Nothing already reminded is reminded twice.
 */

const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const PARENT = '00000000-0000-4000-8000-00000000ad01';
const PARENT_USER = '00000000-0000-4000-8000-00000000aa01';
const GAME = '00000000-0000-4000-8000-0000000000f1';
const NIGHT = '00000000-0000-4000-8000-0000000000f2';
const NY = 'America/New_York';

function household() {
  const db = createInMemorySupabase();
  db.seed('families', [{ id: FAMILY, timezone: NY }]);
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, user_id: PARENT_USER, display_name: 'Dana', role: 'parent', is_active: true, birthday: null },
  ]);
  // Saturday 17 October 10:00 EDT, and Thursday 15 October 18:00 EDT.
  db.seed('sports_events', [{ id: GAME, family_id: FAMILY, member_id: PARENT, title: 'Away game', sport: 'Soccer', location: 'Fairview', starts_at: '2026-10-17T14:00:00.000Z' }]);
  db.seed('school_events', [{ id: NIGHT, family_id: FAMILY, member_id: PARENT, title: 'Parent-teacher night', event_type: 'parent_meeting', starts_at: '2026-10-15T22:00:00.000Z' }]);
  return db;
}

type Notice = { type: string; related_id: string; body: string };
const sent = (db: ReturnType<typeof household>, type: string, id: string) =>
  (db.table('notifications') as Notice[]).filter((n) => n.type === type && n.related_id === id);

async function tick(db: ReturnType<typeof household>, at: string) {
  vi.setSystemTime(new Date(at));
  await generateFamilyNotifications(db as unknown as SupabaseClient<Database>, FAMILY);
}

function move(db: ReturnType<typeof household>, table: 'school_events' | 'sports_events', id: string, startsAt: string) {
  db.replace(table, db.table(table).map((r) => (r.id === id ? { ...r, starts_at: startsAt } : r)));
}

describe('a school or sports event moved after its reminder', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a game moved to next Saturday is reminded again, once', async () => {
    const db = household();
    await tick(db, '2026-10-15T15:00:00.000Z');
    expect(sent(db, 'sports_event', GAME)).toHaveLength(1);

    move(db, 'sports_events', GAME, '2026-10-24T14:00:00.000Z');
    await tick(db, '2026-10-22T15:00:00.000Z');
    expect(sent(db, 'sports_event', GAME), 'the moved game was taken as already reminded').toHaveLength(2);
    expect(sent(db, 'sports_event', GAME)[1]!.body).toBe('Saturday at 10:00 AM · Fairview');

    await tick(db, '2026-10-23T15:00:00.000Z');
    expect(sent(db, 'sports_event', GAME)).toHaveLength(2);
  });

  it('a parent-teacher night pushed back a week is reminded again, once', async () => {
    const db = household();
    await tick(db, '2026-10-14T12:00:00.000Z');
    expect(sent(db, 'school_event', NIGHT)).toHaveLength(1);

    move(db, 'school_events', NIGHT, '2026-10-22T22:00:00.000Z');
    await tick(db, '2026-10-21T12:00:00.000Z');
    expect(sent(db, 'school_event', NIGHT), 'the moved school night was taken as already reminded').toHaveLength(2);

    await tick(db, '2026-10-22T12:00:00.000Z');
    expect(sent(db, 'school_event', NIGHT)).toHaveLength(2);
  });

  it('events that did not move are reminded once across their window', async () => {
    const db = household();
    await tick(db, '2026-10-14T12:00:00.000Z');
    await tick(db, '2026-10-15T15:00:00.000Z');
    await tick(db, '2026-10-16T15:00:00.000Z');
    expect(sent(db, 'sports_event', GAME)).toHaveLength(1);
    expect(sent(db, 'school_event', NIGHT)).toHaveLength(1);
  });

  it('a notice written just before the window on a lagging database clock still counts', async () => {
    const db = household();
    db.seed('notifications', [{
      family_id: FAMILY, user_id: PARENT_USER, type: 'sports_event', related_type: 'sports_events', related_id: GAME,
      title: 'Soccer: Away game', body: 'Saturday at 10:00 AM · Fairview', created_at: '2026-10-15T13:59:00.000Z',
    }]);
    await tick(db, '2026-10-15T15:00:00.000Z');
    expect(sent(db, 'sports_event', GAME)).toHaveLength(1);
  });
});
