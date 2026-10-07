import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { busyEvenings, findConflicts, findEventByTitle, findFreeSlots, searchEvents } from '@/lib/services/calendar';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { entityIdFrom } from '@/lib/notifications/actions';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { bodyOf } from './helpers/source-order';

// The scheduling API (app/api/ai/schedule) reads the same tables itself; its
// session and client come from these two seams, and its words from the
// catalogue, resolved outside a request scope.
const seams = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => seams.db, createServiceClient: () => seams.db }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = {
    user: { id: '00000000-0000-4000-8000-00000000aa01' },
    active: { familyId: '00000000-0000-4000-8000-00000000fa01', role: 'parent', member: { id: '00000000-0000-4000-8000-00000000ad01', role: 'parent' }, family: { timezone: 'America/New_York' } },
  };
  return { requireUserContext: async () => ctx, requireFeature: async () => ctx };
});
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

/**
 * THE PLANNER, THE REMINDER ENGINE AND THE FREE-SLOT FINDER SEE EVERY WEEK OF
 * A SERIES.
 *
 * `calendar_events` stores a recurring event as ONE row whose `starts_at` is
 * its first occurrence. The calendar service's `searchEvents` — the read behind
 * the assistant's calendar tools, the weekly schedule slice, `findConflicts`
 * and the trip planner's commitment check — filtered that column by the
 * window, as did `findFreeSlots`, `busyEvenings`, and both calendar sweeps in
 * lib/server/notifications.ts. So a weekly piano lesson created in August was,
 * from September on: not in any plan the assistant drew up (it proposed over
 * it and reported no clash), not reminded the day before, offered as a free
 * hour, and a dinner night like any other.
 *
 * Every one of those reads now goes through `readCalendarOccurrences`
 * (lib/calendar/occurrences.ts): one-offs by the window, series expanded into
 * the window in the family's zone. The reminder engine's permanent dedupe is
 * keyed by `related_id`, so a series occurrence's key carries its date — keyed
 * by the row alone, the first week's reminder would have stood in for every
 * week after it.
 *
 * The household below is in New York. "Piano" is a weekly series from Tuesday
 * 25 August, 16:00–17:00 local; the week under test is 21–27 September, four
 * weeks later, and nothing in it has the series' own `starts_at`.
 */

const ROOT = join(__dirname, '..');
const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const PARENT = '00000000-0000-4000-8000-00000000ad01';
const PARENT_USER = '00000000-0000-4000-8000-00000000aa01';
const KID = '00000000-0000-4000-8000-00000000c1d1';
const PIANO = '00000000-0000-4000-8000-0000000000e1';
const TEAM_PHOTO = '00000000-0000-4000-8000-0000000000e2';
const DENTIST = '00000000-0000-4000-8000-0000000000e3';
const GRANDMA = '00000000-0000-4000-8000-0000000000e4';
const ANNIVERSARY = '00000000-0000-4000-8000-0000000000e5';
const TZ = 'America/New_York';

/** Monday 21 September 2026, 08:00 in New York. */
const NOW = new Date('2026-09-21T12:00:00.000Z');
/** The week of 21–27 September on New York's wall (EDT, UTC-4). */
const WEEK = { from: '2026-09-21T04:00:00.000Z', to: '2026-09-28T03:59:59.999Z' };

const event = (row: Record<string, unknown>) => ({
  family_id: FAMILY, description: null, location: null, category: 'general', all_day: false,
  recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null,
  created_by: PARENT_USER, onboarding_key: null, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  ...row,
});

function household() {
  const db = createInMemorySupabase();
  db.seed('families', [{ id: FAMILY, timezone: TZ }]);
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, user_id: PARENT_USER, display_name: 'Dana', role: 'parent', is_active: true, birthday: null },
    { id: KID, family_id: FAMILY, user_id: null, display_name: 'Sam', role: 'child', is_active: true, birthday: null },
  ]);
  db.seed('calendar_events', [
    // Tuesday 25 August, 16:00–17:00 EDT, weekly, open-ended. Its own row is
    // four weeks before the week under test.
    event({ id: PIANO, title: 'Piano', starts_at: '2026-08-25T20:00:00.000Z', ends_at: '2026-08-25T21:00:00.000Z', recurrence: 'weekly', assignee_id: KID }),
    // Tuesday 22 September, 16:30–17:30 EDT: booked over the lesson.
    event({ id: TEAM_PHOTO, title: 'Team photo', starts_at: '2026-09-22T20:30:00.000Z', ends_at: '2026-09-22T21:30:00.000Z', assignee_id: KID, category: 'sports' }),
    // Thursday 24 September, 10:00 EDT.
    event({ id: DENTIST, title: 'Dentist', starts_at: '2026-09-24T14:00:00.000Z', ends_at: '2026-09-24T15:00:00.000Z', assignee_id: KID, category: 'appointment' }),
    // A one-off far ahead, and a yearly series whose next date is nine days off.
    event({ id: GRANDMA, title: "Grandma's 80th", starts_at: '2027-01-10T17:00:00.000Z', ends_at: null, category: 'birthday' }),
    event({ id: ANNIVERSARY, title: 'Anniversary', starts_at: '2025-09-30T00:00:00.000Z', ends_at: null, all_day: true, recurrence: 'yearly' }),
  ]);
  return db;
}

const scopeFor = (db: ReturnType<typeof household>): ServiceScope => ({
  db: db as unknown as SupabaseClient<Database>,
  familyId: FAMILY, userId: PARENT_USER, memberId: PARENT, role: 'parent', actorKind: 'member', tz: TZ, now: NOW,
});

const titles = (rows: readonly { title: string }[]) => rows.map((r) => r.title);

describe('searchEvents — the read behind the planner', () => {
  it('returns the occurrence of a weekly series in the week asked about, at that week\'s time', async () => {
    const res = await searchEvents(scopeFor(household()), { from: WEEK.from, to: WEEK.to });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(titles(res.data)).toEqual(['Piano', 'Team photo', 'Dentist']);
    const piano = res.data[0];
    expect(piano.id).toBe(PIANO);
    // Tuesday 22 September 16:00 EDT, with the lesson's hour kept.
    expect(piano.starts_at).toBe('2026-09-22T20:00:00.000Z');
    expect(piano.ends_at).toBe('2026-09-22T21:00:00.000Z');
    // The row's own start, in August, is not what the planner is handed.
    expect(res.data.some((e) => e.starts_at === '2026-08-25T20:00:00.000Z')).toBe(false);
  });

  it('applies the title match and the category filter to series as well as one-offs', async () => {
    const scope = scopeFor(household());
    const byTitle = await searchEvents(scope, { from: WEEK.from, to: WEEK.to, query: 'piano' });
    expect(byTitle.ok && titles(byTitle.data)).toEqual(['Piano']);
    const byCategory = await searchEvents(scope, { from: WEEK.from, to: WEEK.to, categories: ['appointment'] });
    expect(byCategory.ok && titles(byCategory.data)).toEqual(['Dentist']);
    const byAssignee = await searchEvents(scope, { from: WEEK.from, to: WEEK.to, assigneeId: PARENT });
    expect(byAssignee.ok && byAssignee.data).toEqual([]);
  });

  it('cuts the merged list at `limit`, so the nearest things win, not the nearest rows', async () => {
    const res = await searchEvents(scopeFor(household()), { from: WEEK.from, to: WEEK.to, limit: 2 });
    expect(res.ok && titles(res.data)).toEqual(['Piano', 'Team photo']);
  });

  it('with no end: one-offs stay open-ended, a series is expanded for the year ahead', async () => {
    const scope = scopeFor(household());
    const far = await searchEvents(scope, { query: 'grandma' });
    expect(far.ok && far.data.map((e) => e.id)).toEqual([GRANDMA]);
    const yearly = await searchEvents(scope, { query: 'anniversary' });
    expect(yearly.ok && yearly.data.map((e) => [e.id, e.starts_at])).toEqual([[ANNIVERSARY, '2026-09-30T00:00:00.000Z']]);
    const soonest = await searchEvents(scope, { limit: 2 });
    expect(soonest.ok && titles(soonest.data)).toEqual(['Piano', 'Team photo']);
  });

  it('a window that ends before it starts is empty, not an error', async () => {
    const res = await searchEvents(scopeFor(household()), { from: WEEK.to, to: WEEK.from });
    expect(res).toEqual({ ok: true, data: [] });
  });

  it('returns the stored rows, a series once at its own start, when asked not to expand', async () => {
    const scope = scopeFor(household());
    const week = await searchEvents(scope, { from: WEEK.from, to: WEEK.to, expandSeries: false });
    expect(week.ok && titles(week.data)).toEqual(['Team photo', 'Dentist']);
    const august = await searchEvents(scope, { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z', expandSeries: false });
    expect(august.ok && august.data.map((e) => [e.id, e.starts_at])).toEqual([[PIANO, '2026-08-25T20:00:00.000Z']]);
  });

  it('reports a failed read as a failure, never as an empty calendar', async () => {
    const db = household();
    // Every calendar read answers an error. The builder returns ITSELF from
    // each filter, so the proxy has to hand itself back too or the chain
    // escapes it on the first `.select()`.
    const refuse = (builder: object): unknown => {
      const proxy: unknown = new Proxy(builder, {
        get(b, key, r) {
          if (key === 'then') return (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'connection reset' }, count: null });
          const value = Reflect.get(b, key, r);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => { const out = value.apply(b, args); return out === b ? proxy : out; };
        },
      });
      return proxy;
    };
    const refusing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => (table === 'calendar_events' ? refuse(target.from(table)) : target.from(table));
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await searchEvents({ ...scopeFor(db), db: refusing as unknown as SupabaseClient<Database> }, { from: WEEK.from, to: WEEK.to });
    expect(res).toMatchObject({ ok: false, code: 'db' });
  });
});

describe('findConflicts — a one-off booked over a weekly lesson is a clash in the week it is booked', () => {
  it('names the series and the one-off, at the occurrence\'s time', async () => {
    const res = await findConflicts(scopeFor(household()), WEEK);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.conflicts).toHaveLength(1);
    const [clash] = res.data.conflicts;
    expect(clash.assigneeId).toBe(KID);
    expect([...clash.eventIds].sort()).toEqual([PIANO, TEAM_PHOTO].sort());
    expect(clash.startsAt).toBe('2026-09-22T20:00:00.000Z');
    // The events handed back with the clash are the occurrence, not the August row.
    expect(res.data.events[PIANO].starts_at).toBe('2026-09-22T20:00:00.000Z');
  });
});

describe('findFreeSlots — the lesson\'s hour is not free', () => {
  // Tuesday 22 September, 15:00–18:00 EDT, half-hour slots on the half hour.
  const ask = { durationMin: 30, from: '2026-09-22T19:00:00.000Z', to: '2026-09-22T22:00:00.000Z', memberIds: [KID], workingHours: { startHour: 15, endHour: 18 }, granularityMin: 30 };

  it('does not offer 16:00 on a Tuesday to the child who has piano then', async () => {
    const res = await findFreeSlots(scopeFor(household()), ask);
    // Piano 16:00–17:00 and the photo 16:30–17:30 leave 15:00, 15:30 and 17:30.
    expect(res.ok && res.data.map((s) => s.startsAt)).toEqual(['2026-09-22T19:00:00.000Z', '2026-09-22T19:30:00.000Z', '2026-09-22T21:30:00.000Z']);
  });

  it('control: without the series, 16:00 is offered', async () => {
    const db = household();
    db.replace('calendar_events', db.table('calendar_events').filter((row) => row.id !== PIANO));
    const res = await findFreeSlots(scopeFor(db), ask);
    expect(res.ok && res.data.map((s) => s.startsAt)).toContain('2026-09-22T20:00:00.000Z');
  });
});

describe('findEventByTitle — "RSVP to piano" four weeks into the series', () => {
  it('resolves to the next lesson, at its time, rather than "it may have already happened"', async () => {
    const res = await findEventByTitle(household() as unknown as SupabaseClient<Database>, FAMILY, 'piano', NOW.toISOString(), TZ);
    expect(res).toEqual({ ok: true, data: { id: PIANO, title: 'Piano', starts_at: '2026-09-22T20:00:00.000Z', family_id: FAMILY } });
  });

  it('still refuses a title that names two different things, and still says so when nothing is ahead', async () => {
    const db = household() as unknown as SupabaseClient<Database>;
    // "a" is in "Piano", "Team photo", "Anniversary" and "Grandma's 80th".
    const vague = await findEventByTitle(db, FAMILY, 'a', NOW.toISOString(), TZ);
    expect(vague).toMatchObject({ ok: false, code: 'invalid_input' });
    const gone = await findEventByTitle(db, FAMILY, 'sports day', NOW.toISOString(), TZ);
    expect(gone).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('the scheduling API — the same hour, asked for over HTTP', () => {
  // The route clips its window at the real clock; the week under test is in the past of the machine running this.
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not propose the lesson\'s hour to the child who has it', async () => {
    const { POST } = await import('@/app/api/ai/schedule/route');
    const { NextRequest } = await import('next/server');
    seams.db = household();
    const res = await POST(new NextRequest('http://localhost/api/ai/schedule', {
      method: 'POST',
      body: JSON.stringify({
        memberIds: [KID], durationMin: 60, windowStartISO: '2026-09-22T19:00:00.000Z', windowEndISO: '2026-09-22T22:00:00.000Z',
        workingHours: { startHour: 15, endHour: 18 },
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { busyCount: number; slots: { startISO: string; endISO: string }[] };
    // The lesson and the photo are both busy; 15:00 is the only whole hour left.
    expect(body.busyCount).toBe(2);
    expect(body.slots.map((s) => s.startISO)).toEqual(['2026-09-22T19:00:00.000Z']);
  });
});

describe('busyEvenings — a Tuesday lesson takes every Tuesday', () => {
  it('marks the lesson\'s evening in a week four weeks after the series began', async () => {
    const res = await busyEvenings(scopeFor(household()), { from: WEEK.from, to: WEEK.to, eveningFromHour: 16 });
    expect(res).toEqual({ ok: true, data: ['2026-09-22'] });
  });
});

describe('the reminder engine — a weekly lesson is reminded every week', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const written = (db: ReturnType<typeof household>) => db.table('notifications') as { type: string; title: string; related_id: string; user_id: string | null }[];

  it('reminds the household of tomorrow\'s lesson four weeks into the series, keyed by the occurrence', async () => {
    const db = household();
    const count = await generateFamilyNotifications(db as unknown as SupabaseClient<Database>, FAMILY);
    expect(count).toBeGreaterThan(0);
    const reminders = written(db).filter((n) => n.type === 'calendar_event');
    expect(reminders.map((n) => [n.title, n.related_id])).toEqual(expect.arrayContaining([
      ['Piano', `${PIANO}:2026-09-22`],
      // A one-off keeps the key it always had.
      ['Team photo', TEAM_PHOTO],
    ]));
    // Thursday's dentist is past the 48-hour window.
    expect(reminders.some((n) => n.title === 'Dentist')).toBe(false);
    // The composite key still names its event for the bell's link.
    expect(entityIdFrom(`${PIANO}:2026-09-22`)).toBe(PIANO);
  });

  it('flags the clash with the lesson, keyed by its date, and does not repeat itself on the next tick', async () => {
    const db = household();
    await generateFamilyNotifications(db as unknown as SupabaseClient<Database>, FAMILY);
    const clashes = written(db).filter((n) => n.title === 'Schedule conflict');
    // The child has no login, so the manager is told.
    expect(clashes).toHaveLength(1);
    expect(clashes[0].user_id).toBe(PARENT_USER);
    expect(clashes[0].related_id).toBe(`conflict:${[PIANO, TEAM_PHOTO].sort().join('-')}:2026-09-22:${PARENT}`);

    const before = written(db).length;
    const again = await generateFamilyNotifications(db as unknown as SupabaseClient<Database>, FAMILY);
    expect(again).toBe(0);
    expect(written(db)).toHaveLength(before);
  });

  it('a week later, the next lesson is a new reminder — the first week\'s did not stand in for it', async () => {
    const db = household();
    await generateFamilyNotifications(db as unknown as SupabaseClient<Database>, FAMILY);
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'));
    await generateFamilyNotifications(db as unknown as SupabaseClient<Database>, FAMILY);
    const piano = written(db).filter((n) => n.type === 'calendar_event' && n.title === 'Piano').map((n) => n.related_id);
    expect(piano).toEqual([`${PIANO}:2026-09-22`, `${PIANO}:2026-09-29`]);
  });
});

describe('the reads are the shared one (source pins)', () => {
  const service = readFileSync(join(ROOT, 'lib/services/calendar/index.ts'), 'utf8');
  const notifications = readFileSync(join(ROOT, 'lib/server/notifications.ts'), 'utf8');
  const readiness = readFileSync(join(ROOT, 'app/(app)/dashboard/readiness/page.tsx'), 'utf8');
  const exporter = readFileSync(join(ROOT, 'lib/privacy/export.ts'), 'utf8');

  it('searchEvents, findFreeSlots, busyEvenings and the RSVP lookup expand series; only the opt-out reads rows by their first start', () => {
    const search = bodyOf(service, 'export async function searchEvents(', 'async function searchEventRows(');
    expect(search).toContain('readCalendarOccurrences(scope.db');
    expect(search).toContain('calendarOpenWindowFilter(bounds)');
    expect(search).toContain("if (input.expandSeries === false) return searchEventRows(");
    for (const fn of ['export async function findFreeSlots(', 'export async function busyEvenings(']) {
      const body = bodyOf(service, fn, 'settleAll([');
      expect(body, fn).not.toContain(".from('calendar_events')");
      const read = bodyOf(service, fn, ']);');
      expect(read, fn).toContain('readCalendarOccurrences(scope.db, scope.familyId, instantCalendarBounds(fromIso, toIso, tz), tz');
    }
    const lookup = bodyOf(service, 'export async function findEventByTitle(', 'export type RsvpInput');
    expect(lookup).toContain('readCalendarOccurrences(db, familyId, bounds, tz');
    expect(lookup).not.toContain(".from('calendar_events')");
    // The one calendar read left on `starts_at` alone is the opt-out's; the
    // other `gte('starts_at'` filters in the file read the school and sports tables.
    const rows = bodyOf(service, 'async function searchEventRows(', 'export async function findConflicts(');
    expect(rows).toContain(".gte('starts_at', from)");
    const calendarReads = service.split(".from('calendar_events')").slice(1).filter((tail) => /^\s*\.select\('\*'\)[\s\S]{0,200}\.gte\('starts_at'/.test(tail) || /^[\s\S]{0,160}\.gte\('starts_at'/.test(tail));
    expect(calendarReads).toHaveLength(1);
  });

  it('the privacy export is the one caller that asks for rows', () => {
    expect(exporter).toContain('expandSeries: false');
    expect(service.match(/expandSeries: false/g) ?? []).toHaveLength(0);
  });

  it('the reminder engine has no calendar read of its own left', () => {
    expect(notifications).not.toContain(".from('calendar_events')");
    expect(notifications).toContain("related_id: isSeries(e) ? `${e.id}:${occurrenceDay(e, tz)}` : e.id");
    expect(notifications).toContain('refine: (query) => query.not(\'assignee_id\', \'is\', null)');
  });

  it('the scheduling API reads the calendar through the shared read', () => {
    const route = readFileSync(join(ROOT, 'app/api/ai/schedule/route.ts'), 'utf8');
    expect(route).toContain('readCalendarOccurrences(supabase, familyId, instantCalendarBounds(fromISO, toISO, tz), tz, { overlap: true })');
    expect(route).not.toContain(".from('calendar_events')");
  });

  it('the readiness page reads both horizons through the shared read', () => {
    expect(readiness).toContain('briefingCalendarBounds(todayStr, tz, 1, 1)');
    expect(readiness).toContain('briefingCalendarBounds(todayStr, tz, 0, 8)');
    expect(readiness.match(/readCalendarOccurrences\(/g) ?? []).toHaveLength(2);
    // The activity score's own count of upcoming rows is a different question
    // (how much runs through Bubaly) and keeps its row count on purpose.
    expect(readiness.match(/\.from\('calendar_events'\)/g) ?? []).toHaveLength(1);
  });
});
