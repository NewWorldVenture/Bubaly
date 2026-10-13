// Editing a repeating event from a later week must not wipe out the weeks before it.
//
// A repeating event is ONE `calendar_events` row whose `starts_at` is its first
// occurrence. The calendar draws every week of it with that week's own
// `starts_at` (lib/calendar/recurrence.ts), and Edit prefilled the modal from the
// week that was clicked. Save sent that time straight back, and `updateEvent`
// wrote it into the series row, so the series now STARTED on the week the
// parent happened to click.
//
// A parent who fixed the location of Tuesday practice from November's entry
// found September and October gone, this week included if it fell between.
// Reminders, briefs and conflict checks read the same row, so those weeks were
// gone from them too. Moving one week's time did the same.
//
// The modal now says which occurrence it was opened from, and the service maps
// the new start and end back onto the series' own first date, on the family's
// wall clock for a timed series and by date for an all-day one. These cases
// drive the real action and service against an in-memory Postgres.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { fromLocalInput, toLocalInput } from '@/lib/time/local-input';
import { expandEventsInZone } from '@/lib/calendar/recurrence';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { updateCalendarEventAction } from '@/app/(app)/dashboard/calendar/actions';

const FAMILY = 'family-1';
const TZ = 'America/New_York';
const EVENT = 'practice-1';

type Row = Database['public']['Tables']['calendar_events']['Row'];
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

function seed(fields: Partial<Row>) {
  db.table('calendar_events').push({
    id: EVENT, family_id: FAMILY, title: 'Soccer practice', description: null, location: 'North field',
    category: 'sports', starts_at: '2026-09-01T20:00:00.000Z', ends_at: '2026-09-01T21:30:00.000Z', all_day: false,
    recurrence: 'weekly', recurrence_until: null, assignee_id: null, created_by: 'user-1',
    feed_id: null, external_uid: null, idempotency_key: null, ...fields,
  } as unknown as Row);
}

function row(): Row {
  const found = db.table('calendar_events').find((r) => r.id === EVENT);
  if (!found) throw new Error('the event is gone');
  return found as Row;
}

/** The same instant, whatever spelling the column hands back. */
function expectInstant(actual: string | null, expected: string | null, why: string) {
  expect(actual === null ? null : new Date(actual).toISOString(), why).toBe(expected);
}

/** The occurrences of the stored row the calendar would draw in [from, to). */
function occurrences(from: string, to: string, tz = TZ) {
  return expandEventsInZone([row()], new Date(from), new Date(to), tz);
}

/** The one occurrence the calendar draws on `day` (family date). */
function occurrenceOn(day: string, tz = TZ) {
  const found = occurrences(`${day}T00:00:00Z`, `${day}T23:59:59Z`, tz)
    .find((o) => toLocalInput(o.starts_at, tz).startsWith(day) || o.starts_at.startsWith(day));
  if (!found) throw new Error(`no occurrence drawn on ${day}`);
  return found;
}

/**
 * What the Edit modal does: prefill from the clicked occurrence, let the parent
 * change some boxes, resolve them back on the family's clock, and call the
 * action with the occurrence it was opened from.
 */
async function saveFromOccurrence(
  occurrence: { starts_at: string; ends_at: string | null },
  edits: { title?: string; startsBox?: string; endsBox?: string; recurrence?: string } = {},
) {
  const startsBox = edits.startsBox ?? toLocalInput(occurrence.starts_at, TZ);
  const endsBox = edits.endsBox ?? toLocalInput(occurrence.ends_at, TZ);
  const result = await updateCalendarEventAction(EVENT, {
    title: edits.title ?? row().title,
    startsAt: fromLocalInput(startsBox, TZ, occurrence.starts_at) ?? '',
    endsAt: fromLocalInput(endsBox, TZ, occurrence.ends_at) ?? null,
    recurrence: edits.recurrence ?? row().recurrence,
  }, { occurrenceStartsAt: occurrence.starts_at });
  expect(result.ok, result.ok ? '' : result.error).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: { calendar_events: { feed_id: null, external_uid: null, idempotency_key: null } },
  });
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: { familyId: FAMILY, role: 'parent', family: { name: 'Family One', timezone: TZ }, member: { id: 'member-1' } },
  });
  mocks.createServer.mockResolvedValue(db);
});

describe('editing a later week of a weekly event', () => {
  it('a title change from November keeps September and October on the calendar', async () => {
    // Tuesdays 16:00-17:30 New York from 1 September. 3 November is after the
    // clocks go back, so that week is 21:00Z where September's was 20:00Z.
    seed({});
    const november = occurrenceOn('2026-11-03');
    expectInstant(november.starts_at, '2026-11-03T21:00:00.000Z', 'the fixture is the week after DST ends');

    await saveFromOccurrence(november, { title: 'Soccer practice (bring shin guards)' });

    expect(row().title).toBe('Soccer practice (bring shin guards)');
    expectInstant(row().starts_at, '2026-09-01T20:00:00.000Z', 'the series was moved to the week that was edited');
    expectInstant(row().ends_at, '2026-09-01T21:30:00.000Z', 'the series end moved');
    // Every Tuesday from September to the edited week is still drawn.
    expect(occurrences('2026-09-01T00:00:00Z', '2026-11-04T00:00:00Z')).toHaveLength(10);
  });

  it('moving November\'s practice to 17:00 moves every week to 17:00 on the family clock', async () => {
    seed({});
    await saveFromOccurrence(occurrenceOn('2026-11-03'), { startsBox: '2026-11-03T17:00', endsBox: '2026-11-03T18:30' });

    // 17:00 in September is EDT (21:00Z), not the 22:00Z November's 17:00 is.
    expectInstant(row().starts_at, '2026-09-01T21:00:00.000Z', 'the series did not keep its first week');
    expectInstant(row().ends_at, '2026-09-01T22:30:00.000Z', 'the end did not follow');
    const november = occurrenceOn('2026-11-03');
    expect(toLocalInput(november.starts_at, TZ)).toBe('2026-11-03T17:00');
    expect(toLocalInput(november.ends_at, TZ)).toBe('2026-11-03T18:30');
    expect(occurrences('2026-09-01T00:00:00Z', '2026-11-04T00:00:00Z')).toHaveLength(10);
  });

  it('moving November\'s practice to Wednesday moves the series to Wednesdays from its first week', async () => {
    seed({});
    await saveFromOccurrence(occurrenceOn('2026-11-03'), { startsBox: '2026-11-04T16:00', endsBox: '2026-11-04T17:30' });

    expectInstant(row().starts_at, '2026-09-02T20:00:00.000Z', 'the series did not keep its first week');
    expect(toLocalInput(occurrenceOn('2026-11-04').starts_at, TZ)).toBe('2026-11-04T16:00');
  });

  it('a move that crosses the clock change is counted in days on the wall, not in hours', async () => {
    // 27 October is EDT, 3 November is EST: one week on the wall is 169 hours.
    // Shifting the September start by that many hours would land it at 17:00.
    seed({});
    await saveFromOccurrence(occurrenceOn('2026-10-27'), { startsBox: '2026-11-03T16:00', endsBox: '2026-11-03T17:30' });

    expectInstant(row().starts_at, '2026-09-08T20:00:00.000Z', 'the move was not a week on the wall clock');
    expectInstant(row().ends_at, '2026-09-08T21:30:00.000Z', 'the length changed');
  });

  it('an untouched start is the series\' own instant, even in the hour the clocks repeat', async () => {
    // 1 November 2026 shows 01:30 twice in New York; this series starts at the
    // second (EST, 06:30Z). Re-reading "01:30 on 1 November" would pick the first.
    seed({ starts_at: '2026-11-01T06:30:00.000Z', ends_at: '2026-11-01T07:30:00.000Z' });
    await saveFromOccurrence(occurrenceOn('2026-11-08'), { title: 'Night shift handover' });
    expectInstant(row().starts_at, '2026-11-01T06:30:00.000Z', 'an unchanged start was re-read on the wall clock');
    expectInstant(row().ends_at, '2026-11-01T07:30:00.000Z', 'the end moved');
  });

  it('a later end alone lengthens every week, from the first', async () => {
    seed({});
    const result = await updateCalendarEventAction(EVENT, {
      endsAt: fromLocalInput('2026-11-03T18:00', TZ) ?? null,
    }, { occurrenceStartsAt: occurrenceOn('2026-11-03').starts_at });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expectInstant(row().starts_at, '2026-09-01T20:00:00.000Z', 'the start moved');
    expectInstant(row().ends_at, '2026-09-01T22:00:00.000Z', 'the end was not mapped onto the first week');
  });

  it('an all-day series is moved by date', async () => {
    // Saturdays from 5 September, all day. Through the service with DATE
    // labels: the family's clock would turn a date into an evening instant.
    seed({ title: 'Farmers market', starts_at: '2026-09-05T00:00:00.000Z', ends_at: null, all_day: true });
    const result = await updateCalendarEventAction(EVENT, {
      startsAt: '2026-11-08T00:00:00.000Z', endsAt: null,
    }, { occurrenceStartsAt: '2026-11-07T00:00:00.000Z' });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);

    expectInstant(row().starts_at, '2026-09-06T00:00:00.000Z', 'the all-day series was not moved by one date');
    expect(row().all_day).toBe(true);
  });
});

describe('what stays as it was', () => {
  it('editing the first week still moves the series from there', async () => {
    seed({});
    await saveFromOccurrence(occurrenceOn('2026-09-01'), { startsBox: '2026-09-01T17:00', endsBox: '2026-09-01T18:30' });
    expectInstant(row().starts_at, '2026-09-01T21:00:00.000Z', 'the first week did not move');
  });

  it('a series turned into a one-off from a later week stays on the week that was shown', async () => {
    seed({});
    await saveFromOccurrence(occurrenceOn('2026-11-03'), { recurrence: 'none' });
    expect(row().recurrence).toBe('none');
    expectInstant(row().starts_at, '2026-11-03T21:00:00.000Z', 'the one-off was not left where the modal showed it');
  });

  it('a one-off event is written where the person put it, even if it moved since the modal opened', async () => {
    seed({ title: 'Dentist', recurrence: 'none' });
    const result = await updateCalendarEventAction(EVENT, {
      startsAt: fromLocalInput('2026-09-03T09:00', TZ) ?? '', endsAt: fromLocalInput('2026-09-03T10:00', TZ) ?? null,
    }, { occurrenceStartsAt: '2026-08-25T20:00:00.000Z' });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expectInstant(row().starts_at, '2026-09-03T13:00:00.000Z', 'a one-off was shifted like a series');
  });

  it('a one-off made weekly starts where the person put it', async () => {
    seed({ title: 'Piano lesson', recurrence: 'none' });
    const result = await updateCalendarEventAction(EVENT, {
      startsAt: fromLocalInput('2026-09-10T16:00', TZ) ?? '', endsAt: fromLocalInput('2026-09-10T17:00', TZ) ?? null,
      recurrence: 'weekly',
    }, { occurrenceStartsAt: '2026-08-25T20:00:00.000Z' });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(row().recurrence).toBe('weekly');
    expectInstant(row().starts_at, '2026-09-10T20:00:00.000Z', 'a one-off was mapped as though it were already a series');
  });
});

describe('the Edit modal names the occurrence it was opened from', () => {
  it('passes the occurrence start to the update action', () => {
    const src = readFileSync(join(process.cwd(), 'components/modules/calendar-module.tsx'), 'utf8');
    expect(src).toMatch(/updateCalendarEventAction\(existing\.id, fields, \{ occurrenceStartsAt: existing\.starts_at \}\)/);
  });
});
