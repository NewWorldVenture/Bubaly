import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  addDays, allDayDate, compareOccurrences, familyDates, familyFetchRange, occurrenceDay,
} from '@/lib/calendar/day';
import { expandForFamily } from '@/lib/calendar/recurrence';
import { busyIntervals } from '@/lib/calendar/scheduling';
import { buildHeatmap } from '@/lib/calendar/heatmap';
import { formatEventRange } from '@/lib/calendar/event-range';
import { kitchenFetchWindow, kitchenMemberStatus, kitchenToday, kitchenUpcoming } from '@/lib/briefing/kitchen-agenda';
import { createFormat } from '@/lib/utils/format';
import { busyEvenings, findFreeSlots } from '@/lib/services/calendar';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

/**
 * AN ALL-DAY EVENT IS DRAWN ON ITS OWN DATE.
 *
 * An all-day row is a DATE stored as an instant on that date in UTC: Saturday
 * 10 October 2026 is `2026-10-10T00:00:00Z`, whatever zone the family is in.
 * Read through the family's clock that instant is Friday 17:00 in Los Angeles,
 * so every surface that keyed an all-day row by the family's day of its instant
 * drew a Saturday birthday on Friday west of Greenwich: the calendar grid, the
 * month map and the "next seven days" sidebar; the planner's free-slot finder
 * (it blocked Friday and offered Saturday) and busy-evenings check; the busy
 * set the scheduling API builds; the busyness heat map; the event detail line;
 * and the kitchen display, which in Tokyo (+9, where the instant is 09:00)
 * announced the day's all-day row as "next at 9:00 AM". A read that began at
 * the family's midnight (Saturday 07:00Z in Los Angeles) never fetched the
 * first date's all-day row at all.
 *
 * Every one of them now asks lib/calendar/day.ts: a timed row is on the
 * family's day of its instant, an all-day row on its UTC date, a day's list
 * puts all-day rows first, and a read of a run of dates spans both halves.
 * Replayed in Los Angeles, Tokyo and UTC, and on both of Los Angeles's 2026
 * DST Sundays (8 March, a 23-hour day; 1 November, a 25-hour day).
 */

const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';
const UTC = 'UTC';
const ZONES = [LA, TOKYO, UTC] as const;

const allDay = (id: string, day: string, extra: Record<string, unknown> = {}) => ({
  id, title: id, starts_at: `${day}T00:00:00.000Z`, ends_at: null as string | null, all_day: true,
  recurrence: 'none', recurrence_until: null as string | null, assignee_id: null as string | null, ...extra,
});
const timed = (id: string, startsAt: string, endsAt: string | null = null, extra: Record<string, unknown> = {}) => ({
  id, title: id, starts_at: startsAt, ends_at: endsAt, all_day: false,
  recurrence: 'none', recurrence_until: null as string | null, assignee_id: null as string | null, ...extra,
});

describe('the day an occurrence is on (lib/calendar/day.ts)', () => {
  it.each(ZONES)('an all-day row is on its own date in %s', (tz) => {
    expect(occurrenceDay(allDay('Birthday', '2026-10-10'), tz)).toBe('2026-10-10');
    // Both 2026 DST Sundays in Los Angeles.
    expect(occurrenceDay(allDay('Spring forward', '2026-03-08'), tz)).toBe('2026-03-08');
    expect(occurrenceDay(allDay('Fall back', '2026-11-01'), tz)).toBe('2026-11-01');
  });

  it('a timed row is on the family\'s day of its instant', () => {
    // Friday 23:30 in Los Angeles is Saturday 06:30Z.
    expect(occurrenceDay(timed('Late', '2026-10-10T06:30:00.000Z'), LA)).toBe('2026-10-09');
    expect(occurrenceDay(timed('Late', '2026-10-10T06:30:00.000Z'), UTC)).toBe('2026-10-10');
    // Saturday 08:00 in Tokyo is Friday 23:00Z.
    expect(occurrenceDay(timed('Early', '2026-10-09T23:00:00.000Z'), TOKYO)).toBe('2026-10-10');
  });

  it('reads a PostgREST timestamp with an offset, and a bare date, as the same date', () => {
    expect(allDayDate('2026-10-10T00:00:00+00:00')).toBe('2026-10-10');
    expect(allDayDate('2026-10-10')).toBe('2026-10-10');
    expect(allDayDate('not a date')).toBe('');
  });

  it('a day\'s list puts all-day rows first, even where their instant is later in the day', () => {
    // Tokyo: the all-day row's instant is 09:00, after the 08:00 school run.
    const rows = [timed('School run', '2026-10-09T23:00:00.000Z'), allDay('School closed', '2026-10-10'), timed('Thursday', '2026-10-08T23:00:00.000Z')];
    expect(rows.sort((a, b) => compareOccurrences(a, b, TOKYO)).map((r) => r.id)).toEqual(['Thursday', 'School closed', 'School run']);
  });

  it('runs of dates step by date, across both DST Sundays', () => {
    expect(familyDates('2026-03-07', 3)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    expect(familyDates('2026-10-31', 3)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('a read of a run of dates spans the family\'s midnights AND the dates\' UTC midnights', () => {
    // Los Angeles: the family's Saturday starts 07:00Z, after Saturday's all-day row.
    const la = familyFetchRange('2026-10-10', '2026-10-11', LA);
    expect(la.from.toISOString()).toBe('2026-10-10T00:00:00.000Z');
    expect(la.to.toISOString()).toBe('2026-10-11T07:00:00.000Z');
    expect(la.timedFrom.toISOString()).toBe('2026-10-10T07:00:00.000Z');
    // Tokyo: the family's Saturday ends Saturday 15:00Z, before Sunday's UTC midnight.
    const tokyo = familyFetchRange('2026-10-10', '2026-10-11', TOKYO);
    expect(tokyo.from.toISOString()).toBe('2026-10-09T15:00:00.000Z');
    expect(tokyo.to.toISOString()).toBe('2026-10-11T00:00:00.000Z');
    const utc = familyFetchRange('2026-10-10', '2026-10-11', UTC);
    expect([utc.from.toISOString(), utc.to.toISOString()]).toEqual(['2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z']);
    // The two DST Sundays: 23 and 25 family hours.
    const spring = familyFetchRange('2026-03-08', '2026-03-09', LA);
    expect([spring.timedFrom.toISOString(), spring.timedTo.toISOString()]).toEqual(['2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z']);
    const fall = familyFetchRange('2026-11-01', '2026-11-02', LA);
    expect([fall.timedFrom.toISOString(), fall.timedTo.toISOString()]).toEqual(['2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z']);
  });
});

describe('expandForFamily (lib/calendar/recurrence.ts)', () => {
  // The week of Monday 5 – Sunday 11 October 2026.
  const rows = [
    allDay('Monday holiday', '2026-10-05'),
    allDay('Next Monday', '2026-10-12'),
    allDay('Sunday fair', '2026-10-11'),
    allDay('Weekly trash day', '2026-09-30', { recurrence: 'weekly' }), // Wednesdays
    timed('Sunday brunch', '2026-10-11T18:00:00.000Z'),
  ];

  it.each(ZONES)('keeps the week\'s all-day rows on their dates and no other in %s', (tz) => {
    const out = expandForFamily(rows, '2026-10-05', '2026-10-12', tz);
    const days = out.filter((r) => r.all_day).map((r) => [r.id, occurrenceDay(r, tz)]);
    expect(days).toEqual([
      ['Monday holiday', '2026-10-05'],
      ['Weekly trash day', '2026-10-07'],
      ['Sunday fair', '2026-10-11'],
    ]);
  });

  it('keeps a timed row on the family\'s clock', () => {
    // Sunday 18:00Z is Sunday 11:00 in Los Angeles, Monday 03:00 in Tokyo.
    expect(expandForFamily(rows, '2026-10-05', '2026-10-12', LA).some((r) => r.id === 'Sunday brunch')).toBe(true);
    expect(expandForFamily(rows, '2026-10-05', '2026-10-12', TOKYO).some((r) => r.id === 'Sunday brunch')).toBe(false);
  });

  it('a weekly all-day series lands on both DST Sundays by date', () => {
    const series = [allDay('Sunday market', '2026-01-04', { recurrence: 'weekly' })];
    for (const day of ['2026-03-08', '2026-11-01']) {
      const out = expandForFamily(series, day, addDays(day, 1), LA);
      expect(out.map((r) => r.starts_at)).toEqual([`${day}T00:00:00.000Z`]);
    }
  });
});

describe('the busy set the scheduling API builds (lib/calendar/scheduling.ts busyIntervals)', () => {
  it('an all-day Saturday in Los Angeles blocks Saturday, not Friday', () => {
    const [block] = busyIntervals([{ starts_at: '2026-10-10T00:00:00.000Z', all_day: true }], undefined, LA);
    expect(new Date(block.start).toISOString()).toBe('2026-10-10T07:00:00.000Z');
    expect(new Date(block.end).toISOString()).toBe('2026-10-11T07:00:00.000Z');
  });

  it('blocks the whole family day in Tokyo and UTC', () => {
    const [tokyo] = busyIntervals([{ starts_at: '2026-10-10T00:00:00.000Z', all_day: true }], undefined, TOKYO);
    expect([new Date(tokyo.start).toISOString(), new Date(tokyo.end).toISOString()]).toEqual(['2026-10-09T15:00:00.000Z', '2026-10-10T15:00:00.000Z']);
    const [utc] = busyIntervals([{ starts_at: '2026-10-10T00:00:00.000Z', all_day: true }], undefined, UTC);
    expect([new Date(utc.start).toISOString(), new Date(utc.end).toISOString()]).toEqual(['2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z']);
  });

  it('blocks the 23- and 25-hour DST Sundays whole', () => {
    const [spring] = busyIntervals([{ starts_at: '2026-03-08T00:00:00.000Z', all_day: true }], undefined, LA);
    expect([new Date(spring.start).toISOString(), new Date(spring.end).toISOString()]).toEqual(['2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z']);
    const [fall] = busyIntervals([{ starts_at: '2026-11-01T00:00:00.000Z', all_day: true }], undefined, LA);
    expect([new Date(fall.start).toISOString(), new Date(fall.end).toISOString()]).toEqual(['2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z']);
  });
});

describe('the planner (lib/services/calendar findFreeSlots, busyEvenings)', () => {
  const FAMILY = '00000000-0000-4000-8000-00000000fa01';
  const PARENT = '00000000-0000-4000-8000-00000000ad01';
  const PARENT_USER = '00000000-0000-4000-8000-00000000aa01';
  const row = (r: Record<string, unknown>) => ({
    family_id: FAMILY, description: null, location: null, category: 'general', recurrence: 'none', recurrence_until: null,
    assignee_id: null, feed_id: null, external_uid: null, created_by: PARENT_USER, onboarding_key: null,
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z', ends_at: null, ...r,
  });
  const scopeFor = (tz: string, rows: Record<string, unknown>[], now: string): ServiceScope => {
    const db = createInMemorySupabase();
    db.seed('families', [{ id: FAMILY, timezone: tz }]);
    db.seed('calendar_events', rows.map(row));
    return {
      db: db as unknown as SupabaseClient<Database>,
      familyId: FAMILY, userId: PARENT_USER, memberId: PARENT, role: 'parent', actorKind: 'member', tz, now: new Date(now),
    };
  };

  it.each([
    [LA, '2026-10-09T07:00:00.000Z', '2026-10-11T06:59:59.999Z', '2026-10-09T15:00:00.000Z'],
    [TOKYO, '2026-10-08T15:00:00.000Z', '2026-10-10T14:59:59.999Z', '2026-10-08T23:00:00.000Z'],
    [UTC, '2026-10-09T00:00:00.000Z', '2026-10-10T23:59:59.999Z', '2026-10-09T08:00:00.000Z'],
  ])('free slots in %s skip the all-day Saturday and offer Friday', async (tz, from, to, now) => {
    const scope = scopeFor(tz, [{ id: '00000000-0000-4000-8000-0000000000e1', title: 'Tournament', starts_at: '2026-10-10T00:00:00.000Z', all_day: true }], now);
    const res = await findFreeSlots(scope, { durationMin: 60, from, to, limit: 50, granularityMin: 60 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const days = new Set(res.data.map((s) => s.dayKey));
    expect([...days]).toEqual(['2026-10-09']);
  });

  it.each([
    [LA, '2026-10-09T07:00:00.000Z', '2026-10-11T06:59:59.999Z'],
    [TOKYO, '2026-10-08T15:00:00.000Z', '2026-10-10T14:59:59.999Z'],
    [UTC, '2026-10-09T00:00:00.000Z', '2026-10-10T23:59:59.999Z'],
  ])('busy evenings in %s name the all-day row\'s own date', async (tz, from, to) => {
    const scope = scopeFor(tz, [{ id: '00000000-0000-4000-8000-0000000000e1', title: 'Tournament', starts_at: '2026-10-10T00:00:00.000Z', all_day: true }], from);
    const res = await busyEvenings(scope, { from, to });
    expect(res.ok && res.data).toEqual(['2026-10-10']);
  });

  it('busy evenings on both DST Sundays in Los Angeles', async () => {
    for (const [day, from, to] of [
      ['2026-03-08', '2026-03-07T08:00:00.000Z', '2026-03-09T06:59:59.999Z'],
      ['2026-11-01', '2026-10-31T07:00:00.000Z', '2026-11-02T07:59:59.999Z'],
    ] as const) {
      const scope = scopeFor(LA, [{ id: '00000000-0000-4000-8000-0000000000e1', title: 'Fair', starts_at: `${day}T00:00:00.000Z`, all_day: true }], from);
      const res = await busyEvenings(scope, { from, to });
      expect(res.ok && res.data, day).toEqual([day]);
    }
  });
});

describe('the busyness heat map (lib/calendar/heatmap.ts)', () => {
  it.each(ZONES)('counts an all-day row on its own date in %s', (tz) => {
    const report = buildHeatmap([{ startsAt: '2026-10-10T00:00:00.000Z', endsAt: null, allDay: true }], new Date('2026-10-12T12:00:00.000Z'), 1, tz);
    expect(report.days.filter((d) => d.count > 0).map((d) => d.date)).toEqual(['2026-10-10']);
  });

  it('counts the DST Sundays\' all-day rows on those Sundays in Los Angeles', () => {
    for (const day of ['2026-03-08', '2026-11-01']) {
      const report = buildHeatmap([{ startsAt: `${day}T00:00:00.000Z`, endsAt: null, allDay: true }], new Date(`${addDays(day, 2)}T20:00:00.000Z`), 1, LA);
      expect(report.days.filter((d) => d.count > 0).map((d) => d.date), day).toEqual([day]);
    }
  });
});

describe('the event detail line (lib/calendar/event-range.ts)', () => {
  it.each(ZONES)('names an all-day row\'s own date in %s', (tz) => {
    const format = createFormat('en-US', undefined, tz);
    expect(formatEventRange({ starts_at: '2026-10-10T00:00:00.000Z', ends_at: '2026-10-11T00:00:00.000Z', all_day: true }, format)).toBe('Saturday, October 10 · All day');
    expect(formatEventRange({ starts_at: '2026-11-01T00:00:00.000Z', ends_at: null, all_day: true }, format, 'All Day')).toBe('Sunday, November 1 · All Day');
  });

  it('names the last date of a multi-day all-day row (its end is exclusive)', () => {
    const format = createFormat('en-US', undefined, LA);
    expect(formatEventRange({ starts_at: '2026-10-10T00:00:00.000Z', ends_at: '2026-10-13T00:00:00.000Z', all_day: true }, format)).toBe('Saturday, October 10 – Monday, October 12 · All day');
  });

  it('keeps a timed row on the family\'s clock', () => {
    const format = createFormat('en-US', undefined, LA);
    expect(formatEventRange({ starts_at: '2026-10-10T23:00:00.000Z', ends_at: '2026-10-11T00:00:00.000Z', all_day: false }, format)).toBe('Saturday, October 10 · 4:00 PM – 5:00 PM');
  });
});

describe('the kitchen display (lib/briefing/kitchen-agenda.ts)', () => {
  const KID = 'kid';
  const today = (tz: string, key: string) => [
    allDay('Yesterday\'s fair', addDays(key, -1), { assignee_id: KID }),
    allDay('School closed', key, { assignee_id: KID }),
    allDay('Tomorrow\'s trip', addDays(key, 1), { assignee_id: KID }),
    // 16:00 on the family's day.
    timed('Swim', new Date(familyFetchRange(key, addDays(key, 1), tz).timedFrom.getTime() + 16 * 3600_000).toISOString(), null, { assignee_id: KID }),
  ];

  it.each(ZONES)('today in %s is today\'s all-day row, first, and today\'s timed rows', (tz) => {
    const rows = kitchenToday(today(tz, '2026-10-10'), '2026-10-10', tz);
    expect(rows.map((r) => r.id)).toEqual(['School closed', 'Swim']);
  });

  it.each(ZONES)('in %s an all-day row is never "next at" a time: it is on all day, and heads the list', (tz) => {
    // 08:00 on the family's Saturday.
    const now = new Date(familyFetchRange('2026-10-10', '2026-10-11', tz).timedFrom.getTime() + 8 * 3600_000);
    const rows = kitchenToday(today(tz, '2026-10-10'), '2026-10-10', tz);
    expect(kitchenMemberStatus(rows, KID, now)).toEqual({ kind: 'allDay', title: 'School closed' });
    expect(kitchenUpcoming(rows, now).map((r) => [r.id, r.all_day])).toEqual([['School closed', true], ['Swim', false]]);
  });

  it('a timed row under way outranks the all-day row; with neither, the next timed row', () => {
    const tz = TOKYO;
    const dayStart = familyFetchRange('2026-10-10', '2026-10-11', tz).timedFrom.getTime();
    const rows = kitchenToday(today(tz, '2026-10-10'), '2026-10-10', tz);
    expect(kitchenMemberStatus(rows, KID, new Date(dayStart + 16.5 * 3600_000))).toEqual({ kind: 'now', title: 'Swim' });
    const timedOnly = rows.filter((r) => !r.all_day);
    expect(kitchenMemberStatus(timedOnly, KID, new Date(dayStart + 8 * 3600_000))).toEqual({ kind: 'next', title: 'Swim', startsAt: timedOnly[0].starts_at });
  });

  it('the read spans today\'s all-day rows and today\'s family hours, on both DST Sundays too', () => {
    expect(kitchenFetchWindow('2026-10-10', LA)).toEqual({ from: '2026-10-10T00:00:00.000Z', to: '2026-10-11T06:59:59.999Z' });
    expect(kitchenFetchWindow('2026-10-10', TOKYO)).toEqual({ from: '2026-10-09T15:00:00.000Z', to: '2026-10-10T23:59:59.999Z' });
    expect(kitchenFetchWindow('2026-10-10', UTC)).toEqual({ from: '2026-10-10T00:00:00.000Z', to: '2026-10-10T23:59:59.999Z' });
    expect(kitchenFetchWindow('2026-03-08', LA)).toEqual({ from: '2026-03-08T00:00:00.000Z', to: '2026-03-09T06:59:59.999Z' });
    expect(kitchenFetchWindow('2026-11-01', LA)).toEqual({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T07:59:59.999Z' });
  });
});

describe('the surfaces read through those answers', () => {
  const ROOT = join(__dirname, '..');
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

  it('the calendar grid fetches from the grid\'s first UTC date, expands by family dates, and keys all-day rows by their date', () => {
    const src = read('components/modules/calendar-module.tsx');
    expect(src).toContain('familyFetchRange(gridFirstDay, gridEndDay, clock.timeZone)');
    expect(src).toContain('expandForFamily(rawData, gridFirstDay, gridEndDay, clock.timeZone)');
    expect(src).toContain('(e.all_day ? allDayDate(e.starts_at) : clock.dayKeyOf(e.starts_at))');
    // The month map, the all-day row, the timed columns and the sidebar all key through it.
    expect(src.match(/const key = dayOf\(e\);/g)).toHaveLength(4);
    expect(src).not.toContain('clock.toInstant(monthGridStart)');
  });

  it('the kitchen read and its today list go through the kitchen agenda', () => {
    const src = read('components/modules/briefing-module.tsx');
    expect(src).toContain(".gte('starts_at', kitchenFetchWindow(today, familyClock.timeZone).from)");
    expect(src).toContain(".lte('starts_at', kitchenFetchWindow(today, familyClock.timeZone).to)");
    expect(src).toContain('kitchenToday(list, today, familyClock.timeZone)');
    expect(src).toContain('kitchenMemberStatus(todayEvents, memberId, now)');
    expect(src).toContain('kitchenUpcoming(todayEvents, now, 5)');
    expect(src).not.toContain('86_400_000');
  });

  it('the detail modal and the heat strip read all-day rows by their date', () => {
    expect(read('components/modules/event-detail-modal.tsx')).toContain('formatEventRange(e, format,');
    const heat = read('components/calendar/busyness-heatmap.tsx');
    expect(heat).toContain('expandForFamily(rows, fromDay, toDay, clock.timeZone)');
    expect(heat).toContain("familyFetchRange(fromDay, toDay, timeZone)");
  });
});
