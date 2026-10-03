import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { busyEvenings, findFreeSlots } from '@/lib/services/calendar';
import { listPracticesBetween } from '@/lib/services/sports';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { entityIdFrom } from '@/lib/notifications/actions';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A WEEKLY PRACTICE IS ON EVERY WEEK.
 *
 * `sports_events` (0006) carries a recurrence rule, and weekly practice is
 * exactly the row a family enters once. Only the sports service expanded it;
 * the free-slot finder, the busy-evenings check, the reminder engine's 48-hour
 * sweep, the scheduling API, both briefs, the Family Sports hub and the
 * stress signals read the table by `starts_at` — the FIRST practice — so from
 * its second week the practice was a free hour, a quiet evening, an
 * unreminded Tuesday and a load of zero. The stress signals read the calendar
 * the same way, so a weekly event did not count towards the week's load
 * either.
 *
 * Every one of those reads now goes through `readSportsOccurrences` /
 * `readCalendarOccurrences` (lib/calendar/occurrences.ts), one shared core.
 *
 * The household below is in New York. "Soccer practice" is a weekly sports
 * row from Tuesday 25 August, 17:00–18:00 local; the week under test is
 * 21–27 September, four weeks later.
 */

const ROOT = join(__dirname, '..');
const FAMILY = '00000000-0000-4000-8000-00000000fa02';
const PARENT = '00000000-0000-4000-8000-00000000ad02';
const PARENT_USER = '00000000-0000-4000-8000-00000000aa02';
const KID = '00000000-0000-4000-8000-00000000c1d2';
const PRACTICE = '00000000-0000-4000-8000-00000000ab01';
const GAME = '00000000-0000-4000-8000-00000000ab02';
const TZ = 'America/New_York';

/** Monday 21 September 2026, 08:00 in New York. */
const NOW = new Date('2026-09-21T12:00:00.000Z');
const WEEK = { from: '2026-09-21T04:00:00.000Z', to: '2026-09-28T03:59:59.999Z' };

const seams = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => seams.db, createServiceClient: () => seams.db }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = {
    user: { id: '00000000-0000-4000-8000-00000000aa02' },
    active: { familyId: '00000000-0000-4000-8000-00000000fa02', role: 'parent', member: { id: '00000000-0000-4000-8000-00000000ad02', role: 'parent' }, family: { timezone: 'America/New_York' } },
  };
  return { requireUserContext: async () => ctx, requireFeature: async () => ctx };
});
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const sports = (row: Record<string, unknown>) => ({
  family_id: FAMILY, member_id: KID, sport: 'soccer', team: 'Tigers', event_type: 'practice', location: 'Field 3',
  ends_at: null, recurrence: 'none', recurrence_until: null, created_by: PARENT_USER, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  ...row,
});

function household() {
  const db = createInMemorySupabase();
  db.seed('families', [{ id: FAMILY, timezone: TZ }]);
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, user_id: PARENT_USER, display_name: 'Dana', role: 'parent', is_active: true, birthday: null },
    { id: KID, family_id: FAMILY, user_id: null, display_name: 'Sam', role: 'child', is_active: true, birthday: null },
  ]);
  db.seed('sports_events', [
    // Tuesday 25 August, 17:00–18:00 EDT, weekly, open-ended.
    sports({ id: PRACTICE, title: 'Soccer practice', starts_at: '2026-08-25T21:00:00.000Z', ends_at: '2026-08-25T22:00:00.000Z', recurrence: 'weekly' }),
    // Saturday 26 September, 10:00 EDT.
    sports({ id: GAME, title: 'Game vs Fairview', event_type: 'game', starts_at: '2026-09-26T14:00:00.000Z', ends_at: '2026-09-26T15:30:00.000Z' }),
  ]);
  return db;
}

const scopeFor = (db: ReturnType<typeof household>): ServiceScope => ({
  db: db as unknown as SupabaseClient<Database>,
  familyId: FAMILY, userId: PARENT_USER, memberId: PARENT, role: 'parent', actorKind: 'member', tz: TZ, now: NOW,
});

describe('the sports service — the shared read', () => {
  it('lists the practice in the week asked about, at that week\'s time, with the game', async () => {
    const res = await listPracticesBetween(scopeFor(household()), WEEK);
    expect(res.ok && res.data.map((e) => [e.id, e.starts_at, e.ends_at])).toEqual([
      [PRACTICE, '2026-09-22T21:00:00.000Z', '2026-09-22T22:00:00.000Z'],
      [GAME, '2026-09-26T14:00:00.000Z', '2026-09-26T15:30:00.000Z'],
    ]);
  });

  it('keeps the member and event-type filters on both reads', async () => {
    const scope = scopeFor(household());
    const games = await listPracticesBetween(scope, { ...WEEK, eventType: 'game' });
    expect(games.ok && games.data.map((e) => e.id)).toEqual([GAME]);
    const nobody = await listPracticesBetween(scope, { ...WEEK, memberId: PARENT });
    expect(nobody.ok && nobody.data).toEqual([]);
  });
});

describe('findFreeSlots and busyEvenings — the practice is busy every week', () => {
  // Tuesday 22 September, 16:00–19:00 EDT, hour slots on the hour.
  const ask = { durationMin: 60, from: '2026-09-22T20:00:00.000Z', to: '2026-09-22T23:00:00.000Z', memberIds: [KID], workingHours: { startHour: 16, endHour: 19 }, granularityMin: 60 };

  it('does not offer 17:00 on a Tuesday to the child at practice then', async () => {
    const res = await findFreeSlots(scopeFor(household()), ask);
    expect(res.ok && res.data.map((s) => s.startsAt)).toEqual(['2026-09-22T20:00:00.000Z', '2026-09-22T22:00:00.000Z']);
  });

  it('control: without the series, 17:00 is offered', async () => {
    const db = household();
    db.replace('sports_events', db.table('sports_events').filter((row) => row.id !== PRACTICE));
    const res = await findFreeSlots(scopeFor(db), ask);
    expect(res.ok && res.data.map((s) => s.startsAt)).toContain('2026-09-22T21:00:00.000Z');
  });

  it('marks the practice evening four weeks after the series began', async () => {
    const res = await busyEvenings(scopeFor(household()), { from: WEEK.from, to: WEEK.to });
    expect(res).toEqual({ ok: true, data: ['2026-09-22'] });
  });
});

describe('the reminder engine — the practice is reminded every week', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const written = (db: ReturnType<typeof household>) => db.table('notifications') as { type: string; title: string; related_id: string }[];

  it('reminds of tomorrow\'s practice four weeks into the series, keyed by the occurrence, and again a week later', async () => {
    const db = household();
    await generateFamilyNotifications(db as unknown as SupabaseClient<Database>, FAMILY);
    const first = written(db).filter((n) => n.type === 'sports_event');
    expect(first.map((n) => [n.title, n.related_id])).toEqual([['soccer: Soccer practice', `${PRACTICE}:2026-09-22`]]);
    expect(entityIdFrom(first[0].related_id)).toBe(PRACTICE);

    // The next tick writes nothing new; the next week writes the next practice.
    expect(await generateFamilyNotifications(db as unknown as SupabaseClient<Database>, FAMILY)).toBe(0);
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'));
    await generateFamilyNotifications(db as unknown as SupabaseClient<Database>, FAMILY);
    expect(written(db).filter((n) => n.type === 'sports_event').map((n) => n.related_id))
      .toEqual([`${PRACTICE}:2026-09-22`, `${PRACTICE}:2026-09-29`]);
  });
});

describe('the scheduling API and the stress signals', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('the scheduling API counts the practice as busy and does not propose its hour', async () => {
    const { POST } = await import('@/app/api/ai/schedule/route');
    const { NextRequest } = await import('next/server');
    seams.db = household();
    const res = await POST(new NextRequest('http://localhost/api/ai/schedule', {
      method: 'POST',
      body: JSON.stringify({ memberIds: [KID], durationMin: 60, windowStartISO: '2026-09-22T20:00:00.000Z', windowEndISO: '2026-09-22T23:00:00.000Z', workingHours: { startHour: 16, endHour: 19 } }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { busyCount: number; slots: { startISO: string }[] };
    expect(body.busyCount).toBe(1);
    expect(body.slots.map((s) => s.startISO)).not.toContain('2026-09-22T21:00:00.000Z');
    expect(body.slots.map((s) => s.startISO)).toContain('2026-09-22T20:00:00.000Z');
  });

  it('the stress signals count the practice and a weekly calendar event in this week\'s load', async () => {
    const db = household();
    db.seed('calendar_events', [{
      id: '00000000-0000-4000-8000-0000000000e9', family_id: FAMILY, title: 'Piano', starts_at: '2026-08-24T20:00:00.000Z', ends_at: '2026-08-24T21:00:00.000Z',
      all_day: false, recurrence: 'weekly', recurrence_until: null, assignee_id: KID, category: 'general',
    }]);
    seams.db = db;
    const { gatherSignalsResult } = await import('@/lib/family/signals');
    const result = await gatherSignalsResult(FAMILY, TZ, NOW);
    expect(result.error).toBeNull();
    // Monday's piano is today and the week has it once; the practice and
    // Saturday's game are this week's two sports events. Read by first start,
    // the practice was in August and the week had one.
    expect(result.data?.counts).toMatchObject({ eventsToday: 1, maxEventsPerDay: 1, sportsThisWeek: 2 });
  });
});

describe('every sports reader is the shared one (source pins)', () => {
  const FILES = [
    'lib/services/calendar/index.ts', 'lib/server/notifications.ts', 'lib/family/signals.ts', 'app/api/ai/schedule/route.ts',
    'app/api/ai/briefing/route.ts', 'app/api/ai/weekly-briefing/route.ts', 'app/(app)/dashboard/family-sports/page.tsx', 'lib/services/sports/index.ts',
  ];
  it('no reader selects sports_events by its first start any more', () => {
    for (const file of FILES) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(src, file).not.toContain(".from('sports_events')");
      expect(src, file).toContain('readSportsOccurrences(');
    }
  });
  it('the stress signals read the calendar through the shared read too', () => {
    const src = readFileSync(join(ROOT, 'lib/family/signals.ts'), 'utf8');
    expect(src).not.toContain(".from('calendar_events')");
    expect(src).toContain("readCalendarOccurrences(supabase, familyId, instantCalendarBounds(startIso, in7Iso, tz), tz, { columns: ['starts_at'] })");
  });
  it('the reminder engine keys a series practice by its date', () => {
    const src = readFileSync(join(ROOT, 'lib/server/notifications.ts'), 'utf8');
    expect(src).toContain("related_id: isSeries(s) ? `${s.id}:${s.starts_at.slice(0, 10)}` : s.id");
  });
});
