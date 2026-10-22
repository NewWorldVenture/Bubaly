// A zone-less reading — "2026-10-12T09:00", with seconds, with a fraction, or
// a bare date — names ONE instant on the family's clock, whichever surface it
// came in through: a reminder, a school or sports read window, a
// `datetime-local` input, the calendar. Each had its own parser, and they
// disagreed:
//
//   • a fraction ("09:00:00.000", what a model writes) missed the reminders'
//     and school windows' pattern and fell through to `Date.parse` — the HOST's
//     clock, 09:00Z for a Los Angeles family instead of 16:00Z;
//   • an impossible date (30 February) was rolled into March, not refused;
//   • the skipped hour of spring-forward resolved three ways (Los Angeles
//     02:30 on 8 March: 03:00 PDT from the input, 01:30 PST from a reminder,
//     03:30 PDT from a school window), and a day whose MIDNIGHT is skipped
//     (America/Santiago, 6 September 2026) started at 23:00 the evening before;
//   • the repeated hour of fall-back was the first instant in Los Angeles and
//     the SECOND in Berlin;
//   • a `datetime-local` value lost its seconds.
//
// The rule now is RFC 5545 §3.3.5, the calendar's: a repeated reading is the
// first instant, a skipped one keeps the offset before the gap, a bare date
// starts at the day's first instant, seconds and milliseconds are kept, and an
// impossible reading is refused. See lib/time/civil.ts.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { normalizeCalendarWindowInstant } from '@/lib/briefing/calendar-window';
import { getTool } from '@/lib/ai/tools/registry';
import { createReminder } from '@/lib/services/reminders';
import { resolveWindow } from '@/lib/services/school';
import { listPracticesBetween } from '@/lib/services/sports';
import type { ServiceScope } from '@/lib/services/types';
import { datetimeLocalToInstant, instantToDatetimeLocal } from '@/lib/time/datetime-local';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const scopeIn = (tz: string, db: unknown = createInMemorySupabase({ defaults: { family_reminders: { status: 'active', snoozed_until: null, completed_at: null } } })): ServiceScope => ({
  db: db as SupabaseClient<Database>, familyId: 'fam-1', userId: 'user-1', memberId: 'mem-1', role: 'parent', actorKind: 'member', tz,
  now: new Date('2026-10-10T12:00:00Z'),
});

async function reminderAt(tz: string, remindAt: string): Promise<string | null> {
  const scope = scopeIn(tz);
  const res = await createReminder(scope, { title: 'Permission slip', remindAt, kind: 'school' });
  if (!res.ok) return null;
  return new Date(String(res.data.remind_at)).toISOString();
}

describe('a reminder reads a zone-less time on the family clock, whatever its precision', () => {
  it('a fraction is still a reading on the family clock, not the host\'s', async () => {
    expect(await reminderAt('America/Los_Angeles', '2026-10-12T09:00:00.000')).toBe('2026-10-12T16:00:00.000Z');
    expect(await reminderAt('America/Los_Angeles', '2026-10-12T09:00:15.250')).toBe('2026-10-12T16:00:15.250Z');
    expect(await reminderAt('Asia/Tokyo', '2026-10-12 07:00')).toBe('2026-10-11T22:00:00.000Z');
  });

  it('the assistant\'s reminders.create tool stores the fractional 9am at 16:00Z in Los Angeles, as the calendar would', async () => {
    const db = createInMemorySupabase({ defaults: { family_reminders: { status: 'active', snoozed_until: null, completed_at: null } } });
    const tool = getTool('reminders.create');
    expect(tool).toBeDefined();
    const out = await tool!.execute(scopeIn('America/Los_Angeles', db), { title: 'Pay the field-trip fee', remind_at: '2026-10-12T09:00:00.000' });
    expect(out.ok).toBe(true);
    const stored = (db.table('family_reminders') as Record<string, unknown>[])[0];
    expect(new Date(String(stored.remind_at)).toISOString()).toBe('2026-10-12T16:00:00.000Z');
    expect(normalizeCalendarWindowInstant('2026-10-12T09:00:00.000', 'America/Los_Angeles')).toBe('2026-10-12T16:00:00.000Z');
  });

  it('a date that does not exist is refused, not rolled into the next month', async () => {
    for (const value of ['2026-02-30T09:00:00', '2026-02-30', '2026-02-30T09:00:00Z', '2026-04-31T09:00:00-07:00', '2026-10-12T09:00:00.0005']) {
      expect(await reminderAt('America/Los_Angeles', value), value).toBeNull();
    }
  });

  it('the Los Angeles spring gap keeps the offset before it (02:30 → 03:30 PDT), not 01:30 PST', async () => {
    expect(await reminderAt('America/Los_Angeles', '2026-03-08T02:30:00')).toBe('2026-03-08T10:30:00.000Z');
  });

  it('a day whose midnight is skipped (America/Santiago) starts when the clocks jump, not at 23:00 the evening before', async () => {
    expect(await reminderAt('America/Santiago', '2026-09-06')).toBe('2026-09-06T04:00:00.000Z');
    expect(await reminderAt('America/Santiago', '2026-09-06T00:30')).toBe('2026-09-06T04:30:00.000Z');
    // Asia/Beirut skips its midnight too (29 March 2026), from the other side of UTC.
    expect(await reminderAt('Asia/Beirut', '2026-03-29')).toBe('2026-03-28T22:00:00.000Z');
  });

  it('a repeated hour is its FIRST instant, east and west', async () => {
    expect(await reminderAt('America/Los_Angeles', '2026-11-01T01:30')).toBe('2026-11-01T08:30:00.000Z');
    expect(await reminderAt('Europe/Berlin', '2026-10-25T02:30')).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('a school or sports window reads its edges the same way', () => {
  it('a fractional edge is the family\'s time', () => {
    expect(resolveWindow(scopeIn('America/Los_Angeles'), { from: '2026-10-12T17:30:00.000', to: '2026-10-12T19:00:00.000' }))
      .toEqual({ ok: true, data: { from: '2026-10-13T00:30:00.000Z', to: '2026-10-13T02:00:00.000Z' } });
  });

  it('the Santiago midnight-gap day runs from 01:00 (when it begins) to its end, not from 23:00 the day before', () => {
    expect(resolveWindow(scopeIn('America/Santiago'), { from: '2026-09-06', to: '2026-09-06' }))
      .toEqual({ ok: true, data: { from: '2026-09-06T04:00:00.000Z', to: '2026-09-07T02:59:59.999Z', toExclusive: '2026-09-07T03:00:00.000Z' } });
  });

  it('the Los Angeles gap is the same instant a reminder and the calendar give it', () => {
    const window = resolveWindow(scopeIn('America/Los_Angeles'), { from: '2026-03-08T02:30', to: '2026-03-08T04:00' });
    expect(window).toMatchObject({ ok: true, data: { from: '2026-03-08T10:30:00.000Z' } });
    expect(normalizeCalendarWindowInstant('2026-03-08T02:30', 'America/Los_Angeles')).toBe('2026-03-08T10:30:00.000Z');
  });

  it('listPracticesBetween for the Santiago gap day does not report the evening before', async () => {
    const db = createInMemorySupabase({ defaults: { sports_events: { recurrence: 'none', recurrence_until: null, ends_at: null, location: null } } });
    db.seed('sports_events', [
      // Saturday 5 September, 23:30 in Santiago (-04): the evening BEFORE.
      { id: 'saturday', family_id: 'fam-1', member_id: 'mem-child', title: 'Late scrimmage', sport: 'soccer', team: 'Lions', event_type: 'practice', starts_at: '2026-09-06T03:30:00Z' },
      // Sunday 6 September, 10:00 in Santiago (-03).
      { id: 'sunday', family_id: 'fam-1', member_id: 'mem-child', title: 'Sunday practice', sport: 'soccer', team: 'Lions', event_type: 'practice', starts_at: '2026-09-06T13:00:00Z' },
    ]);
    const res = await listPracticesBetween(scopeIn('America/Santiago', db), { from: '2026-09-06', to: '2026-09-06' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((e) => e.id)).toEqual(['sunday']);
  });

  it('refuses a fractional reading of a date that does not exist', () => {
    expect(resolveWindow(scopeIn('America/Los_Angeles'), { from: '2026-02-30T09:00:00.000' })).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

describe('a datetime-local input follows the same rule, and keeps its seconds', () => {
  it('a repeated hour is the FIRST instant in Berlin as in Los Angeles', () => {
    expect(datetimeLocalToInstant('2026-11-01T01:30', 'America/Los_Angeles')).toBe('2026-11-01T08:30:00.000Z');
    expect(datetimeLocalToInstant('2026-10-25T02:30', 'Europe/Berlin')).toBe('2026-10-25T00:30:00.000Z');
    expect(datetimeLocalToInstant('2026-10-25T01:30', 'Europe/London')).toBe('2026-10-25T00:30:00.000Z');
  });

  it('the Los Angeles gap is 03:30 PDT, the instant a reminder and a school window give it', () => {
    expect(datetimeLocalToInstant('2026-03-08T02:30', 'America/Los_Angeles')).toBe('2026-03-08T10:30:00.000Z');
  });

  it('a Santiago midnight-gap reading lands after the jump', () => {
    expect(datetimeLocalToInstant('2026-09-06T00:30', 'America/Santiago')).toBe('2026-09-06T04:30:00.000Z');
  });

  it('seconds (and milliseconds) survive the round trip', () => {
    expect(datetimeLocalToInstant('2026-10-20T14:30:15', 'America/Los_Angeles')).toBe('2026-10-20T21:30:15.000Z');
    expect(instantToDatetimeLocal('2026-10-20T21:30:15.000Z', 'America/Los_Angeles')).toBe('2026-10-20T14:30:15');
    expect(datetimeLocalToInstant('2026-10-20T14:30:15.250', 'Asia/Tokyo')).toBe('2026-10-20T05:30:15.250Z');
    expect(instantToDatetimeLocal('2026-10-20T05:30:15.250Z', 'Asia/Tokyo')).toBe('2026-10-20T14:30:15.250');
  });

  it('a date that does not exist is refused, not normalised', () => {
    expect(datetimeLocalToInstant('2026-02-30T10:00', 'UTC')).toBeNull();
    expect(datetimeLocalToInstant('2026-04-31T10:00', 'America/Los_Angeles')).toBeNull();
  });
});
