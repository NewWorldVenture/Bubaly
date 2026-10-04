// The today views see every week of a series.
//
// After the briefs (#921), the same first-occurrence-only read was still in
// the home page's Today and Coming Up, the kids' day, the kitchen display
// (today, the fortnight, the month's marks), the assistant's "what's coming
// up" context, the chef's week and the digital twin's six-month load. Each
// read `calendar_events` by `starts_at` alone, so a weekly practice was on
// those surfaces the week it was created and never again. All six now read
// through `readCalendarOccurrences`; this file covers what they needed from
// it that the briefs did not — a count before the limit for the home badge,
// one member's events for the twin, the display's overlap filter for
// one-offs — and pins that no bare read remains in any of them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { instantCalendarBounds } from '@/lib/briefing/calendar-window';
import { displayCalendarBounds, displayCalendarFilter, familyDisplayCalendar } from '@/lib/display/calendar';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';

const ROOT = join(__dirname, '..');
const FAMILY = 'family';
const TZ = 'America/New_York';
/** Wednesday 9 September 2026 in New York: 04:00Z to 04:00Z the next day. */
const TODAY = { from: '2026-09-09T04:00:00.000Z', toInclusive: '2026-09-10T03:59:59.999Z' };

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;
const titles = (rows: Array<{ title: string }> | null) => (rows ?? []).map((r) => r.title);

beforeEach(() => {
  db = createInMemorySupabase();
  db.seed('calendar_events', [
    { id: 'soccer', family_id: FAMILY, title: 'Soccer practice', starts_at: '2026-08-19T19:00:00.000Z', ends_at: '2026-08-19T20:00:00.000Z', all_day: false, recurrence: 'weekly', recurrence_until: null, location: 'Field 3', category: 'sports', assignee_id: 'sam' },
    { id: 'bins', family_id: FAMILY, title: 'Bins out', starts_at: '2026-09-01T00:00:00.000Z', ends_at: null, all_day: true, recurrence: 'daily', recurrence_until: null, location: null, category: 'home', assignee_id: null },
    { id: 'dentist', family_id: FAMILY, title: 'Dentist', starts_at: '2026-09-09T13:00:00.000Z', ends_at: '2026-09-09T13:30:00.000Z', all_day: false, recurrence: 'none', recurrence_until: null, location: null, category: 'health', assignee_id: 'alex' },
    { id: 'piano', family_id: FAMILY, title: 'Piano', starts_at: '2026-09-09T21:00:00.000Z', ends_at: '2026-09-09T21:30:00.000Z', all_day: false, recurrence: 'weekly', recurrence_until: null, location: null, category: 'music', assignee_id: 'sam' },
    // An overnight one-off that started yesterday evening and is still running at 04:00Z.
    { id: 'sleepover', family_id: FAMILY, title: 'Sleepover', starts_at: '2026-09-09T00:00:00.000Z', ends_at: '2026-09-09T13:00:00.000Z', all_day: false, recurrence: 'none', recurrence_until: null, location: null, category: null, assignee_id: 'sam' },
  ]);
});

describe('what the today views need from the shared read', () => {
  it('the home badge counts every occurrence while the list is cut (count before limit)', async () => {
    const result = await readCalendarOccurrences(client(), FAMILY, instantCalendarBounds(TODAY.from, TODAY.toInclusive, TZ), TZ, { columns: ['id', 'title', 'starts_at'], limit: 2 });
    expect(result.error).toBeNull();
    expect(titles(result.data)).toEqual(['Bins out', 'Dentist']);
    expect(result.count).toBe(4);
  });

  it("the digital twin reads one member's load, series included", async () => {
    const sam = await readCalendarOccurrences(client(), FAMILY, instantCalendarBounds(TODAY.from, '2026-09-23T03:59:59.999Z', TZ), TZ, { columns: ['id', 'title', 'starts_at'], assigneeId: 'sam', limit: 500 });
    // Two Wednesdays fall in the fortnight (the 9th and the 16th); the 23rd's 19:00Z is past its 04:00Z end.
    expect(titles(sam.data).sort()).toEqual(['Piano', 'Piano', 'Soccer practice', 'Soccer practice']);
    const alex = await readCalendarOccurrences(client(), FAMILY, instantCalendarBounds(TODAY.from, '2026-09-23T03:59:59.999Z', TZ), TZ, { columns: ['id', 'title'], assigneeId: 'alex' });
    expect(titles(alex.data)).toEqual(['Dentist']);
  });

  it("the kitchen display keeps its overlap rule for one-offs and gains this week's occurrence of every series", async () => {
    const calendar = familyDisplayCalendar(new Date('2026-09-09T16:00:00.000Z'), TZ);
    const today = await readCalendarOccurrences(client(), FAMILY, displayCalendarBounds(calendar.todayWindow), calendar.timezone, {
      columns: ['id', 'title', 'starts_at', 'ends_at', 'all_day'], singlesFilter: displayCalendarFilter(calendar.todayWindow),
    });
    // The sleepover started before the day did and is still on; the window filter alone would have dropped it.
    // (It shares its instant with the all-day bins row, which sorts first by id.)
    expect(titles(today.data)).toEqual(['Bins out', 'Sleepover', 'Dentist', 'Soccer practice', 'Piano']);
    const marks = await readCalendarOccurrences(client(), FAMILY, displayCalendarBounds(calendar.monthWindow), calendar.timezone, {
      columns: ['starts_at', 'ends_at', 'all_day'], singlesFilter: displayCalendarFilter(calendar.monthWindow),
    });
    // September: thirty bins, the Wednesdays of soccer (2, 9, 16, 23, 30), piano from the 9th (9, 16, 23, 30), two one-offs.
    expect(marks.data).toHaveLength(30 + 5 + 4 + 2);
  });

  it('the assistant and the chef see the next things on the calendar, bounded and series included', async () => {
    const next = await readCalendarOccurrences(client(), FAMILY, instantCalendarBounds('2026-09-09T14:00:00.000Z', '2026-10-09T14:00:00.000Z', TZ), TZ, { columns: ['title', 'starts_at', 'category', 'all_day'], limit: 12 });
    expect(next.data).toHaveLength(12);
    // An all-day item is today's whatever the hour, so the bins lead; the first timed thing is this afternoon's practice.
    expect(next.data![0]).toMatchObject({ title: 'Bins out', starts_at: '2026-09-09T00:00:00.000Z' });
    expect(next.data!.find((r) => !r.all_day)).toMatchObject({ title: 'Soccer practice', starts_at: '2026-09-09T19:00:00.000Z' });
    expect(titles(next.data), 'the dentist at 13:00Z is already past').not.toContain('Dentist');
  });
});

describe('the six surfaces read through the shared occurrences read', () => {
  it.each([
    'app/(app)/home/page.tsx',
    'app/(app)/kids/page.tsx',
    'app/(app)/display/page.tsx',
    'app/api/ai/chat/route.ts',
    'app/api/ai/chef/route.ts',
    'app/(app)/dashboard/family-digital-twin/actions.ts',
  ])('%s no longer reads calendar_events by its first start alone', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src).toContain('readCalendarOccurrences(');
    expect(src, 'a bare calendar_events read crept back').not.toMatch(/from\('calendar_events'\)/);
  });
});
