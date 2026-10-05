import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { imminentMomentNotices } from '@/lib/moments/notify';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

/**
 * A REMINDER IS KEYED BY THE FAMILY'S DAY.
 *
 * The notification engine's dedupe is permanent and keyed by `related_id`; a
 * series occurrence's key carries its date (`<event>:<date>`), as do a clash
 * with a series (`conflict:<ids>:<date>`) and a "get ready" moment
 * (`moment:<event>:<date>`). That date was `starts_at.slice(0, 10)` —
 * Greenwich's date of the instant. In Los Angeles a daily 16:30 is 00:30Z the
 * next day under PST and 23:30Z the same day under PDT, so on Sunday 8 March
 * 2026, when the clocks go forward, Saturday's occurrence (00:30Z Sunday) and
 * Sunday's (23:30Z Sunday) shared one key, and Sunday's reminder was taken for
 * already sent. The key's date is now the occurrence's day on the family's
 * wall clock (an all-day row's own date).
 */

const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const PARENT = '00000000-0000-4000-8000-00000000ad01';
const PARENT_USER = '00000000-0000-4000-8000-00000000aa01';
const KID = '00000000-0000-4000-8000-00000000c1d1';
const SWIM = '00000000-0000-4000-8000-0000000000e1';
const RECITAL = '00000000-0000-4000-8000-0000000000e2';
const FAIR = '00000000-0000-4000-8000-0000000000e3';
const LA = 'America/Los_Angeles';

const event = (row: Record<string, unknown>) => ({
  family_id: FAMILY, description: null, location: null, category: 'general', all_day: false,
  recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null,
  created_by: PARENT_USER, onboarding_key: null, created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z',
  ends_at: null, ...row,
});

function household(rows: Record<string, unknown>[]) {
  const db = createInMemorySupabase();
  db.seed('families', [{ id: FAMILY, timezone: LA }]);
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, user_id: PARENT_USER, display_name: 'Dana', role: 'parent', is_active: true, birthday: null },
    { id: KID, family_id: FAMILY, user_id: null, display_name: 'Sam', role: 'child', is_active: true, birthday: null },
  ]);
  db.seed('calendar_events', rows.map(event));
  return db;
}

describe('the reminder engine keys a series occurrence by the family\'s day', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const written = (db: ReturnType<typeof household>) => db.table('notifications') as { type: string; title: string; related_id: string; user_id: string | null }[];

  it('Sunday\'s swim on the spring-forward Sunday is reminded, not mistaken for Saturday\'s', async () => {
    // Daily 16:30 in Los Angeles from Sunday 1 March (PST): 00:30Z the next day.
    const db = household([event({ id: SWIM, title: 'Swim', starts_at: '2026-03-02T00:30:00.000Z', ends_at: '2026-03-02T01:30:00.000Z', recurrence: 'daily' })]);
    const client = db as unknown as SupabaseClient<Database>;
    // Friday 6 March, 12:00 PST: the next 48 hours hold Friday's and Saturday's swims.
    vi.setSystemTime(new Date('2026-03-06T20:00:00.000Z'));
    await generateFamilyNotifications(client, FAMILY);
    // Sunday 8 March, 05:00 PDT: the next 48 hours hold Sunday's (23:30Z) and Monday's.
    vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));
    await generateFamilyNotifications(client, FAMILY);
    const swims = written(db).filter((n) => n.type === 'calendar_event').map((n) => n.related_id);
    expect(swims).toEqual([`${SWIM}:2026-03-06`, `${SWIM}:2026-03-07`, `${SWIM}:2026-03-08`, `${SWIM}:2026-03-09`]);
  });

  it('a weekly all-day series is keyed by its own date', async () => {
    const db = household([event({ id: FAIR, title: 'Farmers market', starts_at: '2026-02-28T00:00:00.000Z', all_day: true, recurrence: 'weekly' })]);
    // Friday 6 March, 20:00 PST — Saturday 04:00Z, already the 7th at Greenwich.
    vi.setSystemTime(new Date('2026-03-07T04:00:00.000Z'));
    await generateFamilyNotifications(db as unknown as SupabaseClient<Database>, FAMILY);
    expect(written(db).filter((n) => n.type === 'calendar_event').map((n) => n.related_id)).toEqual([`${FAIR}:2026-03-07`]);
  });

  it('a clash with a series is keyed by the family\'s day of the clash', async () => {
    // Saturday 7 March, 16:30 PST is 00:30Z on the 8th: a one-off recital booked over the swim.
    const db = household([
      event({ id: SWIM, title: 'Swim', starts_at: '2026-03-02T00:30:00.000Z', ends_at: '2026-03-02T01:30:00.000Z', recurrence: 'daily', assignee_id: KID }),
      event({ id: RECITAL, title: 'Recital', starts_at: '2026-03-08T00:45:00.000Z', ends_at: '2026-03-08T01:45:00.000Z', assignee_id: KID }),
    ]);
    vi.setSystemTime(new Date('2026-03-07T18:00:00.000Z'));
    await generateFamilyNotifications(db as unknown as SupabaseClient<Database>, FAMILY);
    const clashes = written(db).filter((n) => n.title === 'Schedule conflict').map((n) => n.related_id);
    expect(clashes).toEqual([`conflict:${[SWIM, RECITAL].sort().join('-')}:2026-03-07:${PARENT}`]);
  });
});

describe('a "get ready" moment is keyed by the family\'s day', () => {
  it('Saturday\'s and Sunday\'s games across the spring-forward night have their own keys', () => {
    const notices = imminentMomentNotices([
      // Saturday 7 March 16:30 PST and Sunday 8 March 16:30 PDT — both on Greenwich's 8th.
      { id: 'sat', title: 'Soccer game', category: null, location: null, starts_at: '2026-03-08T00:30:00.000Z', all_day: false },
      { id: 'sun', title: 'Soccer game', category: null, location: null, starts_at: '2026-03-08T23:30:00.000Z', all_day: false },
    ], [], new Date('2026-03-07T18:00:00.000Z'), 36, LA);
    expect(notices.map((n) => n.relatedId)).toEqual(['moment:sat:2026-03-07', 'moment:sun:2026-03-08']);
  });

  it('an all-day moment keeps its own date', () => {
    const notices = imminentMomentNotices([
      { id: 'meet', title: 'Swim meet', category: null, location: null, starts_at: '2026-03-08T00:00:00.000Z', all_day: true },
    ], [], new Date('2026-03-07T18:00:00.000Z'), 36, LA);
    expect(notices.map((n) => n.relatedId)).toEqual(['moment:meet:2026-03-08']);
  });
});

describe('source pins', () => {
  it('no dedupe key takes Greenwich\'s date of an instant', () => {
    const ROOT = join(__dirname, '..');
    const notifications = readFileSync(join(ROOT, 'lib/server/notifications.ts'), 'utf8');
    expect(notifications).toContain('related_id: isSeries(e) ? `${e.id}:${occurrenceDay(e, tz)}` : e.id');
    expect(notifications).not.toContain('c.startsAt.slice(0, 10)');
    expect(readFileSync(join(ROOT, 'lib/moments/notify.ts'), 'utf8')).not.toContain('relatedId: `moment:${e.id}:${e.starts_at.slice(0, 10)}`');
  });
});
