// The assistant moving one week of a repeating event must not wipe out the weeks before it.
//
// The assistant reads the calendar a week at a time: `calendar.searchEvents`
// returns each week of a series with that week's own `starts_at` and the
// series' id. `calendar.updateEvent` and `calendar.rescheduleEvent` took that id
// and a new start, and wrote the start into the series row, so "move Sam's
// swim on 3 November to 5pm" restarted the series on 3 November and every week
// before it left the calendar. The calendar's Edit modal had the same fault and
// now opens the stored series row instead; the assistant has no row in hand,
// only the weeks it read.
//
// Both tools now take `occurrence_starts_at`, the week being changed, and the
// service maps the change back onto the series' first date, on the family's
// wall clock (by date for an all-day series). A time change on a repeating
// event that names no week is refused with a question, not guessed. That
// matches the service's contract for an ambiguous request (`findEventByTitle`
// refuses "game" when it matches two things), and a guess that kept the first
// date and took only the clock time would silently drop a move to another day.
// One-off events are unchanged.
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { calendarTools } from '@/lib/ai/tools/calendar';
import { describeWhen } from '@/lib/ai/tools/types';
import { expandEventsInZone } from '@/lib/calendar/recurrence';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';
import { instantCalendarBounds } from '@/lib/briefing/calendar-window';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
const TZ = 'America/New_York';
const SWIM = 'swim-1';
const DENTIST = 'dentist-1';
const NOW = new Date('2026-10-30T12:00:00.000Z');

type Row = Database['public']['Tables']['calendar_events']['Row'];
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let scope: ServiceScope;

const tool = (name: string) => {
  const found = calendarTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};
const row = (id: string) => db.table('calendar_events').find((r) => r.id === id) as Row;
const instant = (value: string | null) => (value === null ? null : new Date(value).toISOString());

/**
 * Every update the tools send to calendar_events from here on. `before` runs
 * as an update is built, before the database matches it: another member's
 * change landing between the tool's read and its write.
 */
function watchWrites(before?: () => void) {
  const writes: unknown[] = [];
  const real = db;
  scope = { ...scope, db: new Proxy(real, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver);
      return (table: string) => {
        const builder = target.from(table) as unknown as { update: (patch: unknown) => unknown };
        if (table !== 'calendar_events') return builder;
        const update = builder.update.bind(builder);
        builder.update = (patch) => { writes.push(patch); before?.(); return update(patch); };
        return builder;
      };
    },
  }) };
  return writes;
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>();
  const base = {
    family_id: FAMILY, description: null, location: null, category: 'sports', all_day: false, recurrence_until: null,
    assignee_id: null, created_by: 'user-1', feed_id: null, external_uid: null, idempotency_key: null,
  };
  db.seed('calendar_events', [
    // Tuesdays 16:00-17:30 New York from 1 September. 3 November is after the
    // clocks go back, so that week is 21:00Z where September's was 20:00Z.
    { ...base, id: SWIM, title: 'Swim', starts_at: '2026-09-01T20:00:00.000Z', ends_at: '2026-09-01T21:30:00.000Z', recurrence: 'weekly' },
    { ...base, id: DENTIST, title: 'Dentist', starts_at: '2026-11-03T14:00:00.000Z', ends_at: '2026-11-03T15:00:00.000Z', recurrence: 'none' },
  ]);
  scope = { db, familyId: FAMILY, userId: 'user-1', memberId: 'member-1', role: 'parent', actorKind: 'ai', tz: TZ, now: NOW };
});

describe('calendar.rescheduleEvent on one week of a series', () => {
  it('moving 3 November to 17:00 moves every week from the first, and verifies', async () => {
    const input = { event_id: SWIM, starts_at: '2026-11-03T17:00:00', occurrence_starts_at: '2026-11-03T21:00:00.000Z' };
    const result = await tool('calendar.rescheduleEvent').execute(scope, input);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;

    expect(instant(row(SWIM).starts_at), 'the series was restarted on the week the assistant read').toBe('2026-09-01T21:00:00.000Z');
    expect(instant(row(SWIM).ends_at)).toBe('2026-09-01T22:30:00.000Z');
    // The summary names the week that moved, not the series' first week.
    expect((result.data as { when: string }).when).toBe(describeWhen('2026-11-03T22:00:00.000Z', TZ, NOW));
    const check = await tool('calendar.rescheduleEvent').verify!(scope, input, result.data);
    expect(check).toMatchObject({ ok: true, data: { verified: true } });
  });

  it('a new time for a series that names no week is refused, and nothing moves', async () => {
    const result = await tool('calendar.rescheduleEvent').execute(scope, { event_id: SWIM, starts_at: '2026-11-03T17:00:00' });
    expect(result.ok, 'a week\'s time was written into the series').toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/repeats/);
    expect(instant(row(SWIM).starts_at)).toBe('2026-09-01T20:00:00.000Z');
  });

  it('a one-off event moves as before', async () => {
    const result = await tool('calendar.rescheduleEvent').execute(scope, { event_id: DENTIST, starts_at: '2026-11-04T10:00:00' });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(instant(row(DENTIST).starts_at)).toBe('2026-11-04T15:00:00.000Z');
    expect(instant(row(DENTIST).ends_at)).toBe('2026-11-04T16:00:00.000Z');
  });
});

describe('calendar.updateEvent on one week of a series', () => {
  it('moving 3 November to Wednesday moves the series to Wednesdays from its first week', async () => {
    const result = await tool('calendar.updateEvent').execute(scope, {
      event_id: SWIM, starts_at: '2026-11-04T16:00:00', ends_at: '2026-11-04T17:30:00', occurrence_starts_at: '2026-11-03T21:00:00.000Z',
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(instant(row(SWIM).starts_at), 'the series was restarted on the week the assistant read').toBe('2026-09-02T20:00:00.000Z');
    expect(instant(row(SWIM).ends_at)).toBe('2026-09-02T21:30:00.000Z');
  });

  it('a new time for a series that names no week is refused; a new title is not', async () => {
    const moved = await tool('calendar.updateEvent').execute(scope, { event_id: SWIM, starts_at: '2026-11-03T17:00:00' });
    expect(moved.ok, 'a week\'s time was written into the series').toBe(false);
    // Refused because it repeats, not because a week's start falls after the series' first end.
    expect(moved.ok ? '' : moved.error).toMatch(/repeats/);
    expect(instant(row(SWIM).starts_at)).toBe('2026-09-01T20:00:00.000Z');

    const endOnly = await tool('calendar.updateEvent').execute(scope, { event_id: SWIM, ends_at: '2026-11-03T18:00:00' });
    expect(endOnly.ok, 'a week\'s end was written into the series').toBe(false);
    expect(endOnly.ok ? '' : endOnly.error).toMatch(/repeats/);
    expect(instant(row(SWIM).ends_at)).toBe('2026-09-01T21:30:00.000Z');

    const renamed = await tool('calendar.updateEvent').execute(scope, { event_id: SWIM, title: 'Swim squad' });
    expect(renamed.ok, renamed.ok ? '' : renamed.error).toBe(true);
    expect(row(SWIM).title).toBe('Swim squad');
  });

  it('a one-off event takes the time it is given, as before', async () => {
    const result = await tool('calendar.updateEvent').execute(scope, { event_id: DENTIST, starts_at: '2026-11-05T09:00:00', ends_at: '2026-11-05T09:30:00' });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(instant(row(DENTIST).starts_at)).toBe('2026-11-05T14:00:00.000Z');
  });
});

describe('the move is mapped onto the series on its own clock', () => {
  it('a move across the clock change is counted in days on the wall, not in hours', async () => {
    // 27 October is EDT, 3 November is EST: one week on the wall is 169 hours.
    // Shifting the September start by that many hours would land it at 17:00.
    const result = await tool('calendar.rescheduleEvent').execute(scope, {
      event_id: SWIM, starts_at: '2026-11-03T16:00:00', occurrence_starts_at: '2026-10-27T20:00:00.000Z',
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(instant(row(SWIM).starts_at), 'the move was not a week on the wall clock').toBe('2026-09-08T20:00:00.000Z');
    expect(instant(row(SWIM).ends_at), 'the length changed').toBe('2026-09-08T21:30:00.000Z');
  });

  it('a later end alone lengthens every week, from the first', async () => {
    const result = await tool('calendar.updateEvent').execute(scope, {
      event_id: SWIM, ends_at: '2026-11-03T18:00:00', occurrence_starts_at: '2026-11-03T21:00:00.000Z',
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(instant(row(SWIM).starts_at), 'the start moved').toBe('2026-09-01T20:00:00.000Z');
    expect(instant(row(SWIM).ends_at), 'the end was not mapped onto the first week').toBe('2026-09-01T22:00:00.000Z');
  });

  it('moving the first week moves the series from there', async () => {
    const result = await tool('calendar.rescheduleEvent').execute(scope, {
      event_id: SWIM, starts_at: '2026-09-01T17:00:00', occurrence_starts_at: '2026-09-01T20:00:00.000Z',
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(instant(row(SWIM).starts_at)).toBe('2026-09-01T21:00:00.000Z');
  });

  it('an unchanged start is the series\' own instant, even in the hour the clocks repeat', async () => {
    // 1 November 2026 shows 01:30 twice in New York; this series starts at the
    // second (EST, 06:30Z). Re-reading "01:30 on 1 November" would pick the first.
    db.seed('calendar_events', [{
      ...row(SWIM), id: 'handover-1', title: 'Night shift handover', starts_at: '2026-11-01T06:30:00.000Z', ends_at: '2026-11-01T07:30:00.000Z',
    }]);
    const result = await tool('calendar.updateEvent').execute(scope, {
      event_id: 'handover-1', starts_at: '2026-11-08T06:30:00.000Z', ends_at: '2026-11-08T08:00:00.000Z', occurrence_starts_at: '2026-11-08T06:30:00.000Z',
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(instant(row('handover-1').starts_at), 'an unchanged start was re-read on the wall clock').toBe('2026-11-01T06:30:00.000Z');
    expect(instant(row('handover-1').ends_at)).toBe('2026-11-01T08:00:00.000Z');
  });

  it('a one-off that moved since it was read takes the time it is given', async () => {
    const result = await tool('calendar.updateEvent').execute(scope, {
      event_id: DENTIST, starts_at: '2026-11-05T09:00:00', ends_at: '2026-11-05T10:00:00', occurrence_starts_at: '2026-11-02T14:00:00.000Z',
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(instant(row(DENTIST).starts_at), 'a one-off was shifted like a series').toBe('2026-11-05T14:00:00.000Z');
  });

  it('an all-day series is moved by date', async () => {
    // Saturdays from 5 September; 7 November's market moved to the Sunday.
    db.seed('calendar_events', [{
      ...row(DENTIST), id: 'market-1', title: 'Farmers market', starts_at: '2026-09-05T00:00:00.000Z', ends_at: null,
      all_day: true, recurrence: 'weekly',
    }]);
    const result = await tool('calendar.updateEvent').execute(scope, {
      event_id: 'market-1', starts_at: '2026-11-08T00:00:00.000Z', occurrence_starts_at: '2026-11-07T00:00:00.000Z',
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(instant(row('market-1').starts_at), 'the all-day series was not moved by one date').toBe('2026-09-06T00:00:00.000Z');
    expect(row('market-1').all_day).toBe(true);
  });
});

describe('a week that cannot be read is refused, never written past', () => {
  // `occurrence_starts_at` passes the schema as any string. Unreadable, it was
  // dropped and the new time written into the series row as it stood: the
  // restart this whole change exists to stop.
  it.each([
    ['calendar.updateEvent', { starts_at: '2026-11-04T16:00:00', ends_at: '2026-11-04T17:30:00' }],
    ['calendar.rescheduleEvent', { starts_at: '2026-11-04T16:00:00' }],
  ])('%s with occurrence_starts_at "not-a-date" writes nothing', async (name, times) => {
    const writes = watchWrites();
    const result = await tool(name).execute(scope, { event_id: SWIM, ...times, occurrence_starts_at: 'not-a-date' });
    expect(result.ok, 'an unreadable week let the new time restart the series').toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/week/);
    expect(writes, 'a write was sent').toHaveLength(0);
    expect(instant(row(SWIM).starts_at)).toBe('2026-09-01T20:00:00.000Z');
    expect(instant(row(SWIM).ends_at)).toBe('2026-09-01T21:30:00.000Z');
  });

  it('an unreadable new time with a readable week writes nothing', async () => {
    const writes = watchWrites();
    const result = await tool('calendar.updateEvent').execute(scope, { event_id: SWIM, starts_at: 'after lunch', occurrence_starts_at: '2026-11-03T21:00:00.000Z' });
    expect(result.ok).toBe(false);
    expect(writes).toHaveLength(0);
    expect(instant(row(SWIM).starts_at)).toBe('2026-09-01T20:00:00.000Z');
  });

  it('an unreadable week is refused for a one-off too', async () => {
    const writes = watchWrites();
    const result = await tool('calendar.rescheduleEvent').execute(scope, { event_id: DENTIST, starts_at: '2026-11-04T10:00:00', occurrence_starts_at: 'not-a-date' });
    expect(result.ok).toBe(false);
    expect(writes).toHaveLength(0);
    expect(instant(row(DENTIST).starts_at)).toBe('2026-11-03T14:00:00.000Z');
  });
});

describe('a week is checked against the series as it is now', () => {
  // The assistant read the calendar; then someone moved swim to Wednesdays.
  const toWednesdays = () => {
    const swim = row(SWIM);
    swim.starts_at = '2026-09-02T20:00:00.000Z';
    swim.ends_at = '2026-09-02T21:30:00.000Z';
  };
  const startsOn = (from: string, to: string) => expandEventsInZone([row(SWIM)], new Date(from), new Date(to), TZ).map((o) => instant(o.starts_at));

  it.each([
    ['calendar.updateEvent', { starts_at: '2026-11-04T16:00:00', ends_at: '2026-11-04T17:30:00' }],
    ['calendar.rescheduleEvent', { starts_at: '2026-11-04T16:00:00' }],
  ])('%s refuses a Tuesday read before the series moved to Wednesdays, and writes nothing', async (name, times) => {
    toWednesdays();
    const writes = watchWrites();
    const result = await tool(name).execute(scope, { event_id: SWIM, ...times, occurrence_starts_at: '2026-11-03T21:00:00.000Z' });
    // Mapped as it was, the "Wednesday" anchor moved again, to Thursday 3
    // September, and the calendar showed Thursday 5 November.
    expect(result.ok, 'a week the series no longer has was mapped onto it').toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/week/);
    expect(writes, 'a write was sent').toHaveLength(0);
    expect(instant(row(SWIM).starts_at)).toBe('2026-09-02T20:00:00.000Z');
  });

  it('a week read before the series moved an hour later the same day is refused', async () => {
    // Same Tuesday, so a nearby occurrence exists: only the exact start counts.
    row(SWIM).starts_at = '2026-09-01T21:00:00.000Z';
    row(SWIM).ends_at = '2026-09-01T22:30:00.000Z';
    const writes = watchWrites();
    const result = await tool('calendar.rescheduleEvent').execute(scope, {
      event_id: SWIM, starts_at: '2026-11-04T16:00:00', occurrence_starts_at: '2026-11-03T21:00:00.000Z',
    });
    expect(result.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('a Wednesday read after the move is mapped as asked', async () => {
    toWednesdays();
    const result = await tool('calendar.rescheduleEvent').execute(scope, {
      event_id: SWIM, starts_at: '2026-11-05T16:00:00', occurrence_starts_at: '2026-11-04T21:00:00.000Z',
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(instant(row(SWIM).starts_at)).toBe('2026-09-03T20:00:00.000Z');
    expect(startsOn('2026-11-02T00:00:00Z', '2026-11-09T00:00:00Z')).toEqual(['2026-11-05T21:00:00.000Z']);
  });

  it('a week after the series ended is refused', async () => {
    row(SWIM).recurrence_until = '2026-10-01T04:00:00.000Z';
    const writes = watchWrites();
    const result = await tool('calendar.rescheduleEvent').execute(scope, {
      event_id: SWIM, starts_at: '2026-11-03T17:00:00', occurrence_starts_at: '2026-11-03T21:00:00.000Z',
    });
    expect(result.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  const madeDaily = (swim: Row) => { swim.recurrence = 'daily'; };
  const givenAnEnd = (swim: Row) => { swim.recurrence_until = '2026-12-01T05:00:00.000Z'; };
  it.each([
    ['calendar.rescheduleEvent', 'made daily', madeDaily, {}],
    ['calendar.rescheduleEvent', 'given an end', givenAnEnd, {}],
    ['calendar.updateEvent', 'made daily', madeDaily, { ends_at: '2026-11-03T18:30:00' }],
    ['calendar.updateEvent', 'given an end', givenAnEnd, { ends_at: '2026-11-03T18:30:00' }],
  ])('%s: a series %s between the read and the write is refused', async (name, _change, change, end) => {
    // The week was checked against weekly-and-open; the write must only land
    // on that rule, not on whatever the row became meanwhile.
    const writes = watchWrites(() => change(row(SWIM)));
    const result = await tool(name).execute(scope, {
      event_id: SWIM, starts_at: '2026-11-03T17:00:00', ...end, occurrence_starts_at: '2026-11-03T21:00:00.000Z',
    });
    expect(writes, 'the write was not attempted, so this control proves nothing').toHaveLength(1);
    expect(result.ok, 'the move landed on a rule it was never checked against').toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/changed/);
    expect(instant(row(SWIM).starts_at)).toBe('2026-09-01T20:00:00.000Z');
  });
});

describe('a series with an end keeps every week it had', () => {
  // Every week moves with the one the assistant moved, the series' end
  // included: moved by the same offset as its first week. Kept where it was, a
  // later move pushed the last week past the end and it silently went (and an
  // earlier one could pull a new week in). A move no offset can keep is
  // refused before anything is written.
  const throughNovember3 = () => { row(SWIM).recurrence_until = '2026-11-04T05:00:00.000Z'; };
  const starts = (id: string, from: string, to: string) =>
    expandEventsInZone([row(id)], new Date(from), new Date(to), TZ).map((o) => instant(o.starts_at));

  it('its real last week moved to the Wednesday is still on the calendar', async () => {
    throughNovember3();
    const input = { event_id: SWIM, starts_at: '2026-11-04T16:00:00', occurrence_starts_at: '2026-11-03T21:00:00.000Z' };
    const result = await tool('calendar.rescheduleEvent').execute(scope, input);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    const weeks = starts(SWIM, '2026-08-01T00:00:00Z', '2027-01-01T00:00:00Z');
    expect(weeks, 'the series lost a week').toHaveLength(10);
    expect(weeks.at(0)).toBe('2026-09-02T20:00:00.000Z');
    expect(weeks.at(-1), 'the week that was moved is gone').toBe('2026-11-04T21:00:00.000Z');
    expect(instant(row(SWIM).recurrence_until)).toBe('2026-11-05T05:00:00.000Z');
    const check = await tool('calendar.rescheduleEvent').verify!(scope, input, result.data);
    expect(check).toMatchObject({ ok: true, data: { verified: true } });
  });

  it.each([
    ['its first week', '2026-09-01T20:00:00.000Z', '2026-09-02'],
    ['a middle week', '2026-10-06T20:00:00.000Z', '2026-10-07'],
  ])('%s moved a day later keeps the last week', async (_which, occurrence, day) => {
    throughNovember3();
    const result = await tool('calendar.updateEvent').execute(scope, {
      event_id: SWIM, starts_at: `${day}T16:00:00`, ends_at: `${day}T17:30:00`, occurrence_starts_at: occurrence,
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    const weeks = starts(SWIM, '2026-08-01T00:00:00Z', '2027-01-01T00:00:00Z');
    expect(weeks).toHaveLength(10);
    expect(weeks.at(-1)).toBe('2026-11-04T21:00:00.000Z');
  });

  it('a series too long to count whole is refused, not written as given', async () => {
    // Daily for nearly two years: more steps than the expander will take in
    // one read, so its weeks cannot be checked.
    db.seed('calendar_events', [{
      ...row(SWIM), id: 'vitamins-1', title: 'Vitamins', starts_at: '2026-09-01T12:00:00.000Z', ends_at: null,
      recurrence: 'daily', recurrence_until: '2028-06-01T04:00:00.000Z',
    }]);
    const writes = watchWrites();
    const result = await tool('calendar.rescheduleEvent').execute(scope, {
      event_id: 'vitamins-1', starts_at: '2026-11-03T09:00:00', occurrence_starts_at: '2026-11-03T13:00:00.000Z',
    });
    expect(result.ok).toBe(false);
    expect(writes).toHaveLength(0);
    expect(instant(row('vitamins-1').starts_at)).toBe('2026-09-01T12:00:00.000Z');
  });

  it('a monthly move onto a day February does not have is refused before anything is written', async () => {
    // The 28th of December to March: four months. Moved to the 29th, 2027 has
    // no 29 February, so the series would end with three.
    db.seed('calendar_events', [{
      ...row(SWIM), id: 'lesson-1', title: 'Music lesson', starts_at: '2026-12-28T21:00:00.000Z', ends_at: '2026-12-28T22:00:00.000Z',
      recurrence: 'monthly', recurrence_until: '2027-04-01T04:00:00.000Z',
    }]);
    const writes = watchWrites();
    const result = await tool('calendar.rescheduleEvent').execute(scope, {
      event_id: 'lesson-1', starts_at: '2027-01-29T16:00:00', occurrence_starts_at: '2027-01-28T21:00:00.000Z',
    });
    expect(result.ok, 'a month was silently dropped').toBe(false);
    expect(writes).toHaveLength(0);
    expect(starts('lesson-1', '2026-12-01T00:00:00Z', '2027-05-01T00:00:00Z')).toHaveLength(4);
  });
});

describe('the week asked for is a week of the series as written', () => {
  it('a monthly week moved to a date the series would not land on is refused', async () => {
    // Monthly on the 30th from 30 September. Moving October's to the 31st
    // moves the first date a day, to 1 October: a series on the 1st, which has
    // no 31 October, while the summary named it.
    db.seed('calendar_events', [{
      ...row(SWIM), id: 'club-1', title: 'Book club', starts_at: '2026-09-30T20:00:00.000Z', ends_at: '2026-09-30T21:00:00.000Z',
      recurrence: 'monthly',
    }]);
    const writes = watchWrites();
    const result = await tool('calendar.rescheduleEvent').execute(scope, {
      event_id: 'club-1', starts_at: '2026-10-31T16:00:00', occurrence_starts_at: '2026-10-30T20:00:00.000Z',
    });
    expect(result.ok, 'the series was moved to a date that does not have the week asked for').toBe(false);
    expect(writes).toHaveLength(0);
    expect(instant(row('club-1').starts_at)).toBe('2026-09-30T20:00:00.000Z');
  });
});

describe('a series changed between all-day and timed is mapped on the clock it will be saved with', () => {
  // The move was mapped and checked on the STORED mode's clock (dates, for an
  // all-day series) while the row was saved in the new one, so an all-day week
  // turned into "4:00 PM Tuesday" was saved at 16:00 on September's New York
  // clock and the calendar showed 17:00 on 3 November.
  const ALL_DAY = 'market-1';
  const seedAllDay = (ends: string | null) => db.seed('calendar_events', [{
    ...row(SWIM), id: ALL_DAY, title: 'Market stall', starts_at: '2026-09-01T00:00:00.000Z', ends_at: ends, all_day: true,
  }]);
  /** What the calendar reads for the event on the family's 3 November (and 4th, for an all-day row). */
  async function onNovember3(id: string, tz = TZ) {
    const read = await readCalendarOccurrences(db as never, FAMILY, instantCalendarBounds('2026-11-03T05:00:00.000Z', '2026-11-04T05:00:00.000Z', tz), tz, {
      columns: ['id', 'title', 'starts_at', 'ends_at', 'all_day'],
    });
    if (read.error) throw new Error(read.error.message);
    return (read.data ?? []).filter((o) => o.id === id).map((o) => ({ starts_at: instant(o.starts_at), ends_at: instant(o.ends_at), all_day: o.all_day }));
  }

  it.each([
    ['an explicit end', '2026-09-02T00:00:00.000Z', { ends_at: '2026-11-03T17:00:00' }, '2026-11-03T22:00:00.000Z', '2026-09-01T21:00:00.000Z'],
    ['no end', '2026-09-02T00:00:00.000Z', { ends_at: null }, null, null],
    ['a new end on a series that had none', null, { ends_at: '2026-11-03T17:00:00' }, '2026-11-03T22:00:00.000Z', '2026-09-01T21:00:00.000Z'],
  ])('all-day to 16:00 in New York with %s lands at 16:00 on 3 November', async (_variant, seedEnd, end, novemberEnd, masterEnd) => {
    seedAllDay(seedEnd);
    const result = await tool('calendar.updateEvent').execute(scope, {
      event_id: ALL_DAY, starts_at: '2026-11-03T16:00:00', ...end, all_day: false, occurrence_starts_at: '2026-11-03T00:00:00.000Z',
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect((result.data as { when: string }).when).toBe(describeWhen('2026-11-03T21:00:00.000Z', TZ, NOW));
    expect(row(ALL_DAY).all_day).toBe(false);
    expect(instant(row(ALL_DAY).starts_at), 'the series was saved on the date clock').toBe('2026-09-01T20:00:00.000Z');
    expect(instant(row(ALL_DAY).ends_at)).toBe(masterEnd);
    expect(await onNovember3(ALL_DAY), 'the calendar does not show the week at the time asked for')
      .toEqual([{ starts_at: '2026-11-03T21:00:00.000Z', ends_at: novemberEnd, all_day: false }]);
  });

  it('all-day to 19:00 the evening before, in New York, lands that evening', async () => {
    // 19:00 on 2 November in New York is midnight Greenwich on the 3rd: the
    // same instant as the all-day week, on another date and another clock.
    seedAllDay('2026-09-02T00:00:00.000Z');
    const result = await tool('calendar.updateEvent').execute(scope, {
      event_id: ALL_DAY, starts_at: '2026-11-02T19:00:00', ends_at: '2026-11-02T20:00:00', all_day: false, occurrence_starts_at: '2026-11-03T00:00:00.000Z',
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(instant(row(ALL_DAY).starts_at)).toBe('2026-08-31T23:00:00.000Z');
    const week = expandEventsInZone([row(ALL_DAY)], new Date('2026-11-02T00:00:00Z'), new Date('2026-11-04T00:00:00Z'), TZ).map((o) => instant(o.starts_at));
    expect(week).toEqual(['2026-11-03T00:00:00.000Z']);
  });

  it('all-day to timed in a UTC family lands where asked', async () => {
    seedAllDay('2026-09-02T00:00:00.000Z');
    scope = { ...scope, tz: 'UTC' };
    const result = await tool('calendar.updateEvent').execute(scope, {
      event_id: ALL_DAY, starts_at: '2026-11-03T16:00:00', ends_at: '2026-11-03T17:00:00', all_day: false, occurrence_starts_at: '2026-11-03T00:00:00.000Z',
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(instant(row(ALL_DAY).starts_at)).toBe('2026-09-01T16:00:00.000Z');
    expect(await onNovember3(ALL_DAY, 'UTC')).toEqual([{ starts_at: '2026-11-03T16:00:00.000Z', ends_at: '2026-11-03T17:00:00.000Z', all_day: false }]);
  });

  it('timed to all-day in New York keeps the week on its date', async () => {
    const result = await tool('calendar.updateEvent').execute(scope, {
      event_id: SWIM, starts_at: '2026-11-03T00:00:00Z', ends_at: '2026-11-04T00:00:00Z', all_day: true, occurrence_starts_at: '2026-11-03T21:00:00.000Z',
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(row(SWIM).all_day).toBe(true);
    expect(instant(row(SWIM).starts_at)).toBe('2026-09-01T00:00:00.000Z');
    expect(instant(row(SWIM).ends_at)).toBe('2026-09-02T00:00:00.000Z');
    expect(await onNovember3(SWIM)).toEqual([{ starts_at: '2026-11-03T00:00:00.000Z', ends_at: '2026-11-04T00:00:00.000Z', all_day: true }]);
  });

  it('a late-evening week made all-day keeps the date it had in New York, not Greenwich\'s', async () => {
    // 19:30 on Tuesday 3 November in New York is Wednesday 00:30 Greenwich;
    // September's 19:30 is still Tuesday there. The dates are the family's.
    db.seed('calendar_events', [{
      ...row(SWIM), id: 'study-1', title: 'Study group', starts_at: '2026-09-01T23:30:00.000Z', ends_at: '2026-09-02T00:30:00.000Z',
    }]);
    const result = await tool('calendar.updateEvent').execute(scope, {
      event_id: 'study-1', starts_at: '2026-11-03T00:00:00Z', ends_at: '2026-11-04T00:00:00Z', all_day: true, occurrence_starts_at: '2026-11-04T00:30:00.000Z',
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(instant(row('study-1').starts_at)).toBe('2026-09-01T00:00:00.000Z');
    expect(await onNovember3('study-1')).toEqual([{ starts_at: '2026-11-03T00:00:00.000Z', ends_at: '2026-11-04T00:00:00.000Z', all_day: true }]);
  });

  it('a change of mode with no new start is refused before anything is written', async () => {
    seedAllDay('2026-09-02T00:00:00.000Z');
    const writes = watchWrites();
    const result = await tool('calendar.updateEvent').execute(scope, {
      event_id: ALL_DAY, ends_at: '2026-11-03T17:00:00', all_day: false, occurrence_starts_at: '2026-11-03T00:00:00.000Z',
    });
    expect(result.ok).toBe(false);
    expect(writes).toHaveLength(0);
    expect(row(ALL_DAY).all_day).toBe(true);
  });
});

describe('the week reaches the tools through their input schemas', () => {
  it.each(['calendar.updateEvent', 'calendar.rescheduleEvent'])('%s keeps occurrence_starts_at', (name) => {
    const parsed = tool(name).input.parse({ event_id: SWIM, starts_at: '2026-11-03T17:00:00', occurrence_starts_at: '2026-11-03T21:00:00.000Z' });
    expect(parsed).toMatchObject({ occurrence_starts_at: '2026-11-03T21:00:00.000Z' });
  });
});
