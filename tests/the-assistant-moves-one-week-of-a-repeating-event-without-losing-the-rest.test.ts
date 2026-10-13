// The assistant moving one week of a repeating event must not wipe out the weeks before it.
//
// The assistant reads the calendar a week at a time: `calendar.searchEvents`
// returns each week of a series with that week's own `starts_at` and the
// series' id. `calendar.updateEvent` and `calendar.rescheduleEvent` took that id
// and a new start, and wrote the start into the series row, so "move Sam's
// swim on 3 November to 5pm" restarted the series on 3 November and every week
// before it left the calendar. That is the same re-anchoring the Edit modal had
// (tests/editing-one-week-of-a-repeating-event-keeps-the-earlier-weeks.test.ts).
//
// Both tools now take `occurrence_starts_at`, the week being changed, and go
// through the same service mapping as the modal. A time change on a repeating
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

describe('the week reaches the tools through their input schemas', () => {
  it.each(['calendar.updateEvent', 'calendar.rescheduleEvent'])('%s keeps occurrence_starts_at', (name) => {
    const parsed = tool(name).input.parse({ event_id: SWIM, starts_at: '2026-11-03T17:00:00', occurrence_starts_at: '2026-11-03T21:00:00.000Z' });
    expect(parsed).toMatchObject({ occurrence_starts_at: '2026-11-03T21:00:00.000Z' });
  });
});
