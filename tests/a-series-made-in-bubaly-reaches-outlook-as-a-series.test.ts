// A series made in Bubaly reaches Outlook as a series.
//
// The generic engine pushes a locally-owned `sync_calendar_events` row through
// `adapter.rowToEventBody`. The Microsoft body carried subject, body, location,
// start and end, and nothing else: a weekly lesson the family created in Bubaly
// was created in Outlook once, on its first date, and every later edit patched
// that one event. `rruleToGraphRecurrence` is the inverse of #919's mapping —
// the RRULE the row stores, as Graph's `patternedRecurrence` — read in the zone
// the body's start names (UTC for a timed event, the row's zone for an all-day
// one), with UNTIL turned into the DATE of the last occurrence it allows. A rule
// Graph cannot say leaves the body as it was, with no recurrence, rather than
// sending a different series.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({ fetch: vi.fn(), failures: [] as string[] }));
vi.mock('@/lib/server/fetch-with-deadline', () => ({ fetchWithDeadline: seam.fetch }));
vi.mock('@/lib/sync/access-token', () => ({ getProviderAccessToken: async () => 'access-token' }));
vi.mock('@/lib/services/sync/policy', () => ({
  loadSyncExecutionPolicy: async () => ({ ok: true, data: { mode: 'standard', pull: false, push: true } }),
}));
vi.mock('@/lib/sync/audit', () => ({
  logSyncProviderError: async (_db: unknown, row: { message_redacted: string }) => { seam.failures.push(row.message_redacted); },
  recordSyncFailure: async () => undefined,
}));

import { graphRecurrenceToRrule, rruleToGraphRecurrence } from '@/lib/sync/providers/graph-recurrence';
import { microsoftAdapter, rowToMsEvent } from '@/lib/sync/providers/microsoft';
import { runProviderSync } from '@/lib/sync/engine/generic';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
/** Wednesday 1 July 2026, 19:00Z: the first lesson. */
const TIMED = { startsAt: '2026-07-01T19:00:00.000Z', allDay: false };

describe('rruleToGraphRecurrence', () => {
  it.each([
    ['every other day, ten times', 'FREQ=DAILY;INTERVAL=2;COUNT=10', { type: 'daily', interval: 2 }, { type: 'numbered', startDate: '2026-07-01', numberOfOccurrences: 10 }],
    ['Mondays and Wednesdays, weeks from Monday', 'FREQ=WEEKLY;BYDAY=MO,WE;WKST=MO', { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'wednesday'], firstDayOfWeek: 'monday' }, { type: 'noEnd', startDate: '2026-07-01' }],
    ['the 15th of every month', 'FREQ=MONTHLY;BYMONTHDAY=15', { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 }, { type: 'noEnd', startDate: '2026-07-01' }],
    ['the last Friday of every month', 'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1', { type: 'relativeMonthly', interval: 1, daysOfWeek: ['friday'], index: 'last' }, { type: 'noEnd', startDate: '2026-07-01' }],
    ['the last Friday, written as an ordinal day', 'FREQ=MONTHLY;BYDAY=-1FR', { type: 'relativeMonthly', interval: 1, daysOfWeek: ['friday'], index: 'last' }, { type: 'noEnd', startDate: '2026-07-01' }],
    ['every 25 December', 'FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25', { type: 'absoluteYearly', interval: 1, month: 12, dayOfMonth: 25 }, { type: 'noEnd', startDate: '2026-07-01' }],
    ['the second Sunday of May', 'FREQ=YEARLY;BYMONTH=5;BYDAY=SU;BYSETPOS=2', { type: 'relativeYearly', interval: 1, month: 5, daysOfWeek: ['sunday'], index: 'second' }, { type: 'noEnd', startDate: '2026-07-01' }],
  ])('writes %s', (_label, rrule, pattern, range) => {
    expect(rruleToGraphRecurrence(rrule, TIMED)).toEqual({ pattern, range });
  });

  it('a weekly rule with no BYDAY, a monthly with no BYMONTHDAY and a yearly with no month take them from the start', () => {
    expect(rruleToGraphRecurrence('FREQ=WEEKLY', TIMED)!.pattern).toMatchObject({ type: 'weekly', daysOfWeek: ['wednesday'], firstDayOfWeek: 'sunday' });
    expect(rruleToGraphRecurrence('FREQ=MONTHLY', TIMED)!.pattern).toEqual({ type: 'absoluteMonthly', interval: 1, dayOfMonth: 1 });
    expect(rruleToGraphRecurrence('FREQ=YEARLY', TIMED)!.pattern).toEqual({ type: 'absoluteYearly', interval: 1, month: 7, dayOfMonth: 1 });
  });

  it('turns UNTIL into the date of the last occurrence it allows', () => {
    // 1 October 03:59:59Z (the end of 30 September in New York) is before the 19:00Z lesson: the series ends on the 30th.
    expect(rruleToGraphRecurrence('FREQ=WEEKLY;BYDAY=WE;UNTIL=20261001T035959Z', TIMED)!.range).toEqual({ type: 'endDate', startDate: '2026-07-01', endDate: '2026-09-30' });
    // 1 October 20:00Z is after it: the series may end on the 1st.
    expect(rruleToGraphRecurrence('FREQ=DAILY;UNTIL=20261001T200000Z', TIMED)!.range).toEqual({ type: 'endDate', startDate: '2026-07-01', endDate: '2026-10-01' });
    // An all-day series stores its date as UTC midnight and UNTIL is a date already.
    expect(rruleToGraphRecurrence('FREQ=WEEKLY;BYDAY=SA;UNTIL=20260930', { startsAt: '2026-07-04T00:00:00.000Z', allDay: true })!.range)
      .toEqual({ type: 'endDate', startDate: '2026-07-04', endDate: '2026-09-30' });
  });

  it('round-trips through the pull mapping for every rule Graph can say', () => {
    for (const rrule of [
      'FREQ=DAILY;INTERVAL=2;COUNT=10', 'FREQ=WEEKLY;BYDAY=MO,WE;WKST=MO', 'FREQ=MONTHLY;BYMONTHDAY=15',
      'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1', 'FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25', 'FREQ=YEARLY;BYMONTH=5;BYDAY=SU;BYSETPOS=2',
    ]) {
      const graph = rruleToGraphRecurrence(rrule, TIMED)!;
      expect(graphRecurrenceToRrule(graph, { allDay: false }), rrule).toBe(rrule);
    }
    // With an end date the round trip comes back as the end of that date in UTC, the zone the body named.
    const graph = rruleToGraphRecurrence('FREQ=WEEKLY;BYDAY=WE;UNTIL=20261001T035959Z', TIMED)!;
    expect(graphRecurrenceToRrule(graph, { allDay: false })).toBe('FREQ=WEEKLY;BYDAY=WE;WKST=SU;UNTIL=20260930T235959Z');
  });

  it('refuses what Graph cannot say rather than sending a different series', () => {
    for (const rrule of ['FREQ=HOURLY;INTERVAL=3', 'FREQ=MONTHLY;BYMONTHDAY=1,15', 'FREQ=MONTHLY;BYDAY=MO', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=5', 'FREQ=WEEKLY;BYDAY=XX', 'FREQ=DAILY;COUNT=0', 'FREQ=DAILY;UNTIL=soon', 'INTERVAL=2']) {
      expect(rruleToGraphRecurrence(rrule, TIMED), rrule).toBeNull();
    }
    expect(rruleToGraphRecurrence('FREQ=DAILY', { startsAt: 'not a date', allDay: false })).toBeNull();
  });
});

describe('rowToMsEvent', () => {
  it('carries the series, and a plain row carries none (control)', () => {
    const series = rowToMsEvent({ title: 'Piano', starts_at: '2026-07-01T19:00:00.000Z', ends_at: '2026-07-01T20:00:00.000Z', recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE;UNTIL=20261001T035959Z', timezone: 'America/New_York' });
    expect(series.recurrence).toEqual({
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['wednesday'], firstDayOfWeek: 'sunday' },
      range: { type: 'endDate', startDate: '2026-07-01', endDate: '2026-09-30' },
    });
    expect(rowToMsEvent({ title: 'Dentist', starts_at: '2026-07-15T13:00:00.000Z' })).not.toHaveProperty('recurrence');
    expect(rowToMsEvent({ title: 'Odd', starts_at: '2026-07-15T13:00:00.000Z', recurrence_rule: 'FREQ=HOURLY' })).not.toHaveProperty('recurrence');
  });
});

describe('the generic engine pushing a locally-owned series through the Microsoft adapter', () => {
  const FAMILY = '00000000-0000-4000-8000-0000000000f3';
  const ACCOUNT = { id: '00000000-0000-4000-8000-0000000000a3', user_id: '00000000-0000-4000-8000-0000000000e3', family_id: FAMILY, external_id: 'parent@outlook.test' };
  const CAL = '00000000-0000-4000-8000-0000000000c3';
  const PIANO = '00000000-0000-4000-8000-0000000000d3';
  let db: InMemorySupabase;
  const adapter = { ...microsoftAdapter, defaultTaskListId: async () => 'tasks', listTasks: async () => [] };
  const posted: Array<{ url: string; body: Record<string, unknown> }> = [];

  beforeEach(() => {
    seam.fetch.mockReset(); seam.failures = []; posted.length = 0;
    seam.fetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith('/me/calendars')) return json({ value: [{ id: 'cal-1', name: 'Calendar', isDefaultCalendar: true }] });
      if (url.endsWith('/me/calendars/cal-1/events') && init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
        return json({ id: 'ms-created', changeKey: 'ck-created' });
      }
      throw new Error(`unexpected Graph call: ${init?.method ?? 'GET'} ${url}`);
    });
    db = createInMemorySupabase();
    db.seed('sync_accounts', [{ id: ACCOUNT.id, user_id: ACCOUNT.user_id, family_id: FAMILY, provider: 'microsoft', external_id: ACCOUNT.external_id, sync_status: 'idle' }]);
    db.seed('sync_connections', [{ account_id: ACCOUNT.id, family_id: FAMILY, provider: 'microsoft', health: 'unknown' }]);
    db.seed('sync_calendars', [{ id: CAL, family_id: FAMILY, user_id: ACCOUNT.user_id, account_id: ACCOUNT.id, provider: 'microsoft', external_id: 'cal-1', name: 'Calendar', timezone: 'UTC', is_owned_locally: false, sync_token: null }]);
    db.seed('sync_calendar_events', [{
      id: PIANO, calendar_id: CAL, family_id: FAMILY, user_id: ACCOUNT.user_id, provider: 'internal', external_id: null, uid: null,
      title: 'Piano', description: null, location: 'Music room', starts_at: '2026-07-01T19:00:00.000Z', ends_at: '2026-07-01T20:00:00.000Z', all_day: false,
      timezone: 'America/New_York', recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE;UNTIL=20261001T035959Z', status: 'confirmed', content_hash: null, deleted_at: null, sync_status: 'pending',
    }]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('creates the Outlook event with its recurrence, once, and records the mapping', async () => {
    const result = await runProviderSync(db as unknown as SupabaseClient<Database>, ACCOUNT, adapter);
    expect(seam.failures).toEqual([]);
    expect(result).toMatchObject({ exported: 1, imported: 0, conflicts: 0 });
    expect(result.error).toBeUndefined();

    expect(posted).toHaveLength(1);
    expect(posted[0].body).toMatchObject({
      subject: 'Piano',
      start: { dateTime: '2026-07-01T19:00:00.000', timeZone: 'UTC' },
      recurrence: {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['wednesday'], firstDayOfWeek: 'sunday' },
        range: { type: 'endDate', startDate: '2026-07-01', endDate: '2026-09-30' },
      },
    });
    const mapping = db.table('sync_external_mappings').find((m) => (m as Row).local_id === PIANO) as Row;
    expect(mapping).toMatchObject({ external_id: 'ms-created', external_etag: 'ck-created', provider: 'microsoft', item_type: 'event' });
    expect(db.table('sync_calendar_events')[0]).toMatchObject({ sync_status: 'synced' });
  });
});
