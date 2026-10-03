// An Outlook series mirrors as a series.
//
// Microsoft Graph describes a recurring event as a `seriesMaster` with a
// structured `recurrence` (pattern + range), and lists the occurrences the user
// changed or cancelled as `exception` events naming their `seriesMasterId` and
// `originalStart`. The Outlook mapper wrote `recurrence_rule: null` for every
// event and knew nothing of `type`, so a weekly piano lesson mirrored — and was
// published to every subscribed phone — as the one occasion it started on, and
// an `occurrence` that reached the pull would have been mirrored beside its
// master as a second copy.
//
// `graphRecurrenceToRrule` writes the pattern as the RRULE the rest of the
// calendar stack speaks, with UNTIL computed in the series' own zone (Graph
// names it the Windows way: "Eastern Standard Time"); the mapper marks an
// exception with its master and the slot it left, which lib/sync/engine/
// exceptions folds into the master's exception dates; the delta pull skips
// occurrences. The last block drives the real generic engine with the real
// Microsoft adapter over a faked Graph, every write through the in-memory
// client — the generic engine's half of the exception wiring, exercised.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({ fetch: vi.fn(), failures: [] as string[] }));
vi.mock('@/lib/server/fetch-with-deadline', () => ({ fetchWithDeadline: seam.fetch }));
vi.mock('@/lib/sync/access-token', () => ({ getProviderAccessToken: async () => 'access-token' }));
vi.mock('@/lib/services/sync/policy', () => ({
  loadSyncExecutionPolicy: async () => ({ ok: true, data: { mode: 'standard', pull: true, push: false } }),
}));
vi.mock('@/lib/sync/audit', () => ({
  logSyncProviderError: async (_db: unknown, row: { message_redacted: string }) => { seam.failures.push(row.message_redacted); },
  recordSyncFailure: async () => undefined,
}));

import { graphRecurrenceToRrule, graphZoneToIana } from '@/lib/sync/providers/graph-recurrence';
import { isSeriesOccurrence, microsoftAdapter, msEventToRow, type MsEvent } from '@/lib/sync/providers/microsoft';
import { runProviderSync } from '@/lib/sync/engine/generic';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const utc = (dateTime: string) => ({ dateTime: `${dateTime}.0000000`, timeZone: 'UTC' });

/** Wednesdays 15:00 New York (19:00Z in summer) until the end of September, as Graph sends the master. */
const MASTER: MsEvent = {
  id: 'ms-piano', type: 'seriesMaster', iCalUId: 'piano@outlook', subject: 'Piano', changeKey: 'ck-master', lastModifiedDateTime: '2026-07-01T00:00:00Z',
  start: utc('2026-07-01T19:00:00'), end: utc('2026-07-01T20:00:00'), originalStartTimeZone: 'Eastern Standard Time',
  recurrence: {
    pattern: { type: 'weekly', interval: 1, daysOfWeek: ['wednesday'], firstDayOfWeek: 'sunday' },
    range: { type: 'endDate', startDate: '2026-07-01', endDate: '2026-09-30', recurrenceTimeZone: 'Eastern Standard Time' },
  },
};
const MOVED: MsEvent = {
  id: 'ms-piano-0722', type: 'exception', seriesMasterId: 'ms-piano', iCalUId: 'piano@outlook', subject: 'Piano (Thursday this week)', changeKey: 'ck-moved',
  originalStart: '2026-07-22T19:00:00Z', start: utc('2026-07-23T19:00:00'), end: utc('2026-07-23T20:00:00'),
};
const CANCELLED: MsEvent = {
  id: 'ms-piano-0729', type: 'exception', seriesMasterId: 'ms-piano', iCalUId: 'piano@outlook', isCancelled: true,
  originalStart: '2026-07-29T19:00:00Z', start: utc('2026-07-29T19:00:00'), end: utc('2026-07-29T20:00:00'),
};
const OCCURRENCE: MsEvent = {
  id: 'ms-piano-0708', type: 'occurrence', seriesMasterId: 'ms-piano', iCalUId: 'piano@outlook', subject: 'Piano',
  start: utc('2026-07-08T19:00:00'), end: utc('2026-07-08T20:00:00'),
};
const DENTIST: MsEvent = {
  id: 'ms-dentist', type: 'singleInstance', iCalUId: 'dentist@outlook', subject: 'Dentist', changeKey: 'ck-d',
  start: utc('2026-07-15T13:00:00'), end: utc('2026-07-15T13:30:00'),
};

/** A faked Graph: the calendar list and one delta page, routed by URL. */
function graphAnswers(events: MsEvent[]) {
  seam.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/me/calendars')) return json({ value: [{ id: 'cal-1', name: 'Calendar', isDefaultCalendar: true }] });
    if (url.includes('/events/delta')) return json({ value: events, '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal-1/events/delta?$deltatoken=after' });
    throw new Error(`unexpected Graph call: ${url}`);
  });
}

beforeEach(() => { seam.fetch.mockReset(); seam.failures = []; });
afterEach(() => { vi.restoreAllMocks(); });

describe('graphRecurrenceToRrule', () => {
  it.each([
    ['every other day, ten times', { pattern: { type: 'daily', interval: 2 }, range: { type: 'numbered', numberOfOccurrences: 10 } }, 'FREQ=DAILY;INTERVAL=2;COUNT=10'],
    ['Mondays and Wednesdays, weeks starting Monday, no end', { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'wednesday'], firstDayOfWeek: 'monday' }, range: { type: 'noEnd' } }, 'FREQ=WEEKLY;BYDAY=MO,WE;WKST=MO'],
    ['the 15th of every month', { pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 }, range: { type: 'noEnd' } }, 'FREQ=MONTHLY;BYMONTHDAY=15'],
    ['the last Friday of every month', { pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['friday'], index: 'last' }, range: { type: 'noEnd' } }, 'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1'],
    ['every 25 December', { pattern: { type: 'absoluteYearly', interval: 1, month: 12, dayOfMonth: 25 }, range: { type: 'noEnd' } }, 'FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25'],
    ['the second Sunday of May', { pattern: { type: 'relativeYearly', interval: 1, month: 5, daysOfWeek: ['sunday'], index: 'second' }, range: { type: 'noEnd' } }, 'FREQ=YEARLY;BYMONTH=5;BYDAY=SU;BYSETPOS=2'],
  ])('writes %s', (_label, recurrence, rrule) => {
    expect(graphRecurrenceToRrule(recurrence, { allDay: false })).toBe(rrule);
  });

  it('ends a timed series at the last second of its end date in the zone Graph named, the Windows way', () => {
    // 30 September 23:59:59 in New York (EDT) is 1 October 03:59:59Z.
    expect(graphRecurrenceToRrule(MASTER.recurrence, { allDay: false })).toBe('FREQ=WEEKLY;BYDAY=WE;WKST=SU;UNTIL=20261001T035959Z');
    // Tokyo: 30 September 23:59:59 is 14:59:59Z the same day.
    const tokyo = { pattern: { type: 'daily' }, range: { type: 'endDate', endDate: '2026-09-30', recurrenceTimeZone: 'Tokyo Standard Time' } };
    expect(graphRecurrenceToRrule(tokyo, { allDay: false })).toBe('FREQ=DAILY;UNTIL=20260930T145959Z');
  });

  it("falls back to the event's own zone, then UTC, for a zone name it does not know", () => {
    const unknown = { pattern: { type: 'daily' }, range: { type: 'endDate', endDate: '2026-09-30', recurrenceTimeZone: 'Nowhere Standard Time' } };
    expect(graphRecurrenceToRrule(unknown, { allDay: false, zoneHint: 'Pacific Standard Time' })).toBe('FREQ=DAILY;UNTIL=20261001T065959Z');
    expect(graphRecurrenceToRrule(unknown, { allDay: false })).toBe('FREQ=DAILY;UNTIL=20260930T235959Z');
  });

  it('ends an all-day series on a date, as RFC 5545 asks when DTSTART is a date', () => {
    const rec = { pattern: { type: 'weekly', daysOfWeek: ['saturday'] }, range: { type: 'endDate', endDate: '2026-09-30', recurrenceTimeZone: 'Eastern Standard Time' } };
    expect(graphRecurrenceToRrule(rec, { allDay: true })).toBe('FREQ=WEEKLY;BYDAY=SA;UNTIL=20260930');
  });

  it('refuses a pattern it does not know rather than inventing a rule', () => {
    expect(graphRecurrenceToRrule({ pattern: { type: 'lunar' }, range: { type: 'noEnd' } }, { allDay: false })).toBeNull();
    expect(graphRecurrenceToRrule(null, { allDay: false })).toBeNull();
    expect(graphRecurrenceToRrule({ pattern: {}, range: {} }, { allDay: false })).toBeNull();
  });

  it('knows the Windows zone names Graph emits, passes an IANA name through, and says so for one it cannot compute in', () => {
    expect(graphZoneToIana('Eastern Standard Time')).toBe('America/New_York');
    expect(graphZoneToIana('India Standard Time')).toBe('Asia/Kolkata');
    expect(graphZoneToIana('Europe/Berlin')).toBe('Europe/Berlin');
    expect(graphZoneToIana('Nowhere Standard Time')).toBeNull();
    expect(graphZoneToIana(null)).toBeNull();
  });
});

describe('msEventToRow, for a series', () => {
  it('a series master carries its RRULE', () => {
    const row = msEventToRow(MASTER);
    expect(row.recurrence_rule).toBe('FREQ=WEEKLY;BYDAY=WE;WKST=SU;UNTIL=20261001T035959Z');
    expect(row).toMatchObject({ recurring_event_id: null, original_starts_at: null, exception_dates: [] });
  });

  it('an exception names its master and the slot it left, whether moved or cancelled', () => {
    expect(msEventToRow(MOVED)).toMatchObject({
      recurring_event_id: 'ms-piano', original_starts_at: '2026-07-22T19:00:00.000Z', starts_at: '2026-07-23T19:00:00.000Z', cancelled: false, recurrence_rule: null,
    });
    expect(msEventToRow(CANCELLED)).toMatchObject({ recurring_event_id: 'ms-piano', original_starts_at: '2026-07-29T19:00:00.000Z', cancelled: true });
  });

  it('a plain event is as it was (control)', () => {
    expect(msEventToRow(DENTIST)).toMatchObject({ recurrence_rule: null, recurring_event_id: null, original_starts_at: null, exception_dates: [] });
  });

  it('only an occurrence is skipped by the delta pull', () => {
    expect(isSeriesOccurrence(OCCURRENCE)).toBe(true);
    expect([MASTER, MOVED, CANCELLED, DENTIST].map(isSeriesOccurrence)).toEqual([false, false, false, false]);
  });
});

describe('the delta pull', () => {
  it('leaves occurrences out and keeps masters, exceptions and single events', async () => {
    graphAnswers([OCCURRENCE, MASTER, MOVED, CANCELLED, DENTIST]);
    const pull = await microsoftAdapter.pullEvents('token', 'cal-1', null);
    expect(pull.events.map((e) => e.external_id)).toEqual(['ms-piano', 'ms-piano-0722', 'ms-piano-0729', 'ms-dentist']);
    expect(pull.nextCursor).toContain('$deltatoken=after');
    expect(pull.expired).toBe(false);
  });
});

describe('the generic engine with the Microsoft adapter', () => {
  const FAMILY = '00000000-0000-4000-8000-0000000000f2';
  const ACCOUNT = { id: '00000000-0000-4000-8000-0000000000a2', user_id: '00000000-0000-4000-8000-0000000000e2', family_id: FAMILY, external_id: 'parent@outlook.test' };
  let db: InMemorySupabase;
  const mirror = () => db.table('sync_calendar_events') as Array<Row & { external_id: string }>;
  const rowFor = (externalId: string) => mirror().find((r) => r.external_id === externalId);
  // Tasks are not this unit's; the engine still opens the default list.
  const adapter = { ...microsoftAdapter, defaultTaskListId: async () => 'tasks', listTasks: async () => [] };

  beforeEach(() => {
    db = createInMemorySupabase();
    db.seed('sync_accounts', [{ id: ACCOUNT.id, user_id: ACCOUNT.user_id, family_id: FAMILY, provider: 'microsoft', external_id: ACCOUNT.external_id, sync_status: 'idle' }]);
    db.seed('sync_connections', [{ account_id: ACCOUNT.id, family_id: FAMILY, provider: 'microsoft', health: 'unknown' }]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('mirrors the series once, with the slots its exceptions left, and the moved occurrence as its own override', async () => {
    graphAnswers([OCCURRENCE, MOVED, CANCELLED, DENTIST, MASTER]);
    const result = await runProviderSync(db as unknown as SupabaseClient<Database>, ACCOUNT, adapter);
    expect(seam.failures).toEqual([]);
    expect(result.error).toBeUndefined();

    expect(rowFor('ms-piano')).toMatchObject({
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE;WKST=SU;UNTIL=20261001T035959Z',
      exception_dates: ['2026-07-22T19:00:00.000Z', '2026-07-29T19:00:00.000Z'],
      recurrence_id: null,
    });
    expect(rowFor('ms-piano-0722')).toMatchObject({ uid: 'piano@outlook', starts_at: '2026-07-23T19:00:00.000Z', recurrence_id: '2026-07-22T19:00:00.000Z' });
    expect(rowFor('ms-piano-0708'), 'the occurrence is the master\'s to expand').toBeUndefined();
    expect(rowFor('ms-piano-0729'), 'a cancelled occurrence never mirrored has nothing to delete').toBeUndefined();
    expect(rowFor('ms-dentist')).toMatchObject({ recurrence_rule: null, exception_dates: [] });
    expect(result).toMatchObject({ imported: 3, skipped: 1, conflicts: 0 });
    expect((db.table('sync_calendars')[0] as Row).sync_token).toContain('$deltatoken=after');
  });
});
