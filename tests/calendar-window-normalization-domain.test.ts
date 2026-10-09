import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  briefingCalendarBounds, briefingCalendarWindow, calendarOpenWindowFilter,
  calendarOverlapWindowFilter, calendarWindowFilter, estimatedEndLookback,
  instantCalendarBounds, normalizeCalendarWindowInstant,
} from '@/lib/briefing/calendar-window';
import { parseExactInstant } from '@/lib/calendar/exact-instant';
import { searchEvents } from '@/lib/services/calendar';
import { orPredicate } from './helpers/in-memory-supabase';

// Native Date/Intl and the installed SDK with a synthetic, read-only transport.
// The service scope is supplied, so this is not real authentication/RLS proof.
const FAMILY = '10000000-0000-4000-8000-000000000001';
function sdk(rows: Record<string, unknown>[] = []) {
  const calls: URL[] = [];
  const db = createClient('https://calendar-window.synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input)); calls.push(url);
      expect(url.origin).toBe('https://calendar-window.synthetic.invalid');
      expect(url.pathname).toBe('/rest/v1/calendar_events');
      expect(init?.method ?? 'GET').toBe('GET');
      expect(url.searchParams.get('family_id')).toBe('eq.' + FAMILY);
      const filter = url.searchParams.get('or');
      const selected = filter ? rows.filter(orPredicate(filter.slice(1, -1))) : rows;
      return Response.json(selected, { headers: { 'content-range': `0-${Math.max(0, selected.length - 1)}/${selected.length}` } });
    } },
  });
  return { db, calls };
}
afterEach(() => vi.restoreAllMocks());

describe('calendar window final normalized instant domain', () => {
  it.each([
    ['0001-01-01T00:00', 'Asia/Tokyo'],
    ['0001-01-01T00:00:00.000000001', 'Asia/Tokyo'],
    ['0001-01-01T00:00:00+01:00', 'UTC'],
  ])('refuses a supported input whose normalized instant escapes below AD1: %s %s', (input, zone) => {
    expect(() => normalizeCalendarWindowInstant(input, zone)).toThrow();
    expect(() => instantCalendarBounds(input, input, zone)).toThrow();
  });

  it.each([
    ['0001-01-01T00:00', 'Asia/Tokyo'],
    ['0001-01-01T00:00:00.000000001', 'Asia/Tokyo'],
    ['0001-01-01T00:00:00+01:00', 'UTC'],
  ])('refuses the same invalid normalized raw-row search before SDK transport: %s %s', async (from, tz) => {
    const probe = sdk();
    const scope = { db: probe.db, familyId: FAMILY, userId: 'synthetic-user', memberId: 'synthetic-member', role: 'parent' as const, actorKind: 'member' as const, tz };
    const result = await searchEvents(scope, { from, expandSeries: false });
    expect(result.ok).toBe(false);
    expect(probe.calls).toEqual([]);
  });

  it.each([
    ['0001-01-01T00:00:00Z', 'UTC', '0001-01-01T00:00:00.000Z'],
    ['0001-01-01', 'Asia/Tokyo', '0001-01-01T00:00:00.000Z'],
    ['2026-10-09', 'America/Los_Angeles', '2026-10-09T00:00:00.000Z'],
    ['2026-10-09T12:30', 'America/New_York', '2026-10-09T16:30:00.000Z'],
    ['2026-10-09T12:30:42.123456789', 'America/New_York', '2026-10-09T16:30:42.123456789Z'],
    ['2026-10-09T12:30:42.100000000', 'America/New_York', '2026-10-09T16:30:42.100000000Z'],
    ['2026-10-09T12:30:42.000001+05:45', 'UTC', '2026-10-09T06:45:42.000001Z'],
    ['2026-10-09T12:30:42-03:30', 'Asia/Tokyo', '2026-10-09T16:00:42.000Z'],
    ['0001-01-01T23:59:00+23:59', 'UTC', '0001-01-01T00:00:00.000Z'],
    ['9999-12-31T00:00:00Z', 'UTC', '9999-12-31T00:00:00.000Z'],
  ])('retains accepted bare/floating/absolute clock and declared precision: %s', (value, zone, expected) => {
    const normalized = normalizeCalendarWindowInstant(value, zone);
    expect(normalized).toBe(expected);
    expect(parseExactInstant(normalized)).toBe(parseExactInstant(expected));
  });

  it('keeps the normalizer default UTC independent of host time', () => {
    expect(normalizeCalendarWindowInstant('2026-10-09T12:30')).toBe('2026-10-09T12:30:00.000Z');
  });

  it.each([
    ['2026-03-08T02:30:42.000001', 'America/New_York', '2026-03-08T07:30:42.000001Z'],
    ['2026-11-01T01:30:42.000001', 'America/New_York', '2026-11-01T05:30:42.000001Z'],
    ['2011-12-30T12:30:00', 'Pacific/Apia', '2011-12-30T22:30:00.000Z'],
  ])('retains RFC pre-gap offset and earliest fold resolution: %s', (input, zone, expected) => {
    expect(normalizeCalendarWindowInstant(input, zone)).toBe(expected);
  });

  it.each(['', 'bad', '0000-12-31', '2026-02-30', '2026-10-09T24:00', '2026-10-09T12:60', '2026-10-09T12:30:60', '2026-10-09T12:30:00.1234567890', '2026-10-09T12:30:00+24:00', '2026-10-09T12:30:00+01:60', ' 2026-10-09T12:30:00Z ', '+010000-01-01T00:00:00Z'])('does not invent a clock for malformed token %s', value => {
    expect(() => normalizeCalendarWindowInstant(value, 'UTC')).toThrow();
  });

  it.each(['', 'Not/AZone', ' Mars/Olympus '])('refuses unusable zones before a normalizer clock is admitted: %s', zone => {
    expect(() => normalizeCalendarWindowInstant('2026-10-09', zone)).toThrow();
    expect(() => briefingCalendarBounds('2026-10-09', zone, 0, 1)).toThrow();
    expect(() => instantCalendarBounds('2026-10-09T00:00:00Z', '2026-10-09T01:00:00Z', zone)).toThrow();
  });
});

describe('all public calendar bounds and formatter contracts', () => {
  it.each([
    ['UTC', '2026-10-09', '2026-10-09T00:00:00.000Z', '2026-10-10T00:00:00.000Z'],
    ['America/New_York', '2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['America/New_York', '2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ['Asia/Kathmandu', '2026-10-09', '2026-10-08T18:15:00.000Z', '2026-10-09T18:15:00.000Z'],
    ['Pacific/Apia', '2011-12-30', '2011-12-30T10:00:00.000Z', '2011-12-30T10:00:00.000Z'],
    ['UTC', '0001-01-01', '0001-01-01T00:00:00.000Z', '0001-01-02T00:00:00.000Z'],
    ['UTC', '9999-12-30', '9999-12-30T00:00:00.000Z', '9999-12-31T00:00:00.000Z'],
  ])('uses complete family-day bounds %s %s', (zone, day, from, to) => {
    const bounds = briefingCalendarBounds(day, zone, 0, 1);
    expect(bounds.timedFrom).toBe(from); expect(bounds.timedTo).toBe(to);
    expect(bounds.allDayFromDay).toBe(day);
    expect(briefingCalendarWindow(day, zone, 0, 1)).toBe(calendarWindowFilter(bounds));
  });

  it('offsets the window by calendar days and keeps a single bounded formatter search', () => {
    const parts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    const bounds = briefingCalendarBounds('2026-03-07', 'America/New_York', 1, 2);
    expect(bounds).toEqual({ timedFrom: '2026-03-08T05:00:00.000Z', timedTo: '2026-03-10T04:00:00.000Z', allDayFromDay: '2026-03-08', allDayToDay: '2026-03-10' });
    expect(parts.mock.calls.length).toBeLessThanOrEqual(62);
  });

  it.each([['2026-02-30', 0, 1], ['0000-12-31', 0, 1], ['9999-12-31', 0, 1], ['2026-10-09', -1, 1], ['2026-10-09', 0, 0], ['2026-10-09', 0.5, 1], ['2026-10-09', 0, Number.NaN], ['2026-10-09', 0, Number.POSITIVE_INFINITY], ['2026-10-09', Number.MAX_SAFE_INTEGER, 1]] as const)('refuses an unrepresentable DATE window %s %s %s', (day, offset, count) => {
    expect(() => briefingCalendarBounds(day, 'UTC', offset, count)).toThrow();
  });

  it.each([
    ['2026-10-09T12:30:00Z', '2026-10-09T12:30:00.001Z'],
    ['2026-10-09T12:30:00.000000Z', '2026-10-09T12:30:00.000001Z'],
    ['2026-10-09T12:30:00.000000000Z', '2026-10-09T12:30:00.000000001Z'],
    ['2026-10-09T23:59:59.999999999Z', '2026-10-10T00:00:00.000Z'],
  ])('advances inclusive endpoint only by its declared unit %s', (last, exclusive) => {
    const bounds = instantCalendarBounds('2026-10-09T00:00:00Z', last, 'UTC');
    expect(bounds.timedTo).toBe(exclusive);
    expect(bounds.allDayFromDay).toBe('2026-10-09'); expect(bounds.allDayToDay).toBe('2026-10-10');
  });

  it('uses the exact family day while preserving a submillisecond lower endpoint', () => {
    expect(instantCalendarBounds('2026-10-09T01:00:00.000000001Z', '2026-10-09T02:00:00.000000009Z', 'America/Los_Angeles')).toEqual({ timedFrom: '2026-10-09T01:00:00.000000001Z', timedTo: '2026-10-09T02:00:00.00000001Z', allDayFromDay: '2026-10-08', allDayToDay: '2026-10-09' });
  });

  it.each([
    ['2026-10-09T12:30:00.000009Z', '2026-10-09T12:30:00.000001Z', 'UTC'],
    ['9999-12-31T00:00:00Z', '9999-12-31T00:00:00Z', 'UTC'],
    ['0001-01-01T00:00:00Z', '0001-01-01T00:30:00Z', 'America/New_York'],
    ['9999-12-31T23:59:59Z', '9999-12-31T23:59:59Z', 'Asia/Tokyo'],
  ])('refuses reversed/exclusive/projected-domain overflow %s %s %s', (from, to, zone) => {
    expect(() => instantCalendarBounds(from, to, zone)).toThrow();
  });

  it.each([
    ['0001-01-01T00:00:00Z', '0001-01-01T00:00:00.000Z', 'gte'],
    ['0001-01-01T00:59:59.999999999Z', '0001-01-01T00:00:00.000Z', 'gte'],
    ['0001-01-01T01:00:00Z', '0001-01-01T00:00:00.000Z', 'gt'],
    ['0001-01-01T01:00:00.000000001Z', '0001-01-01T00:00:00.000000001Z', 'gt'],
    ['2026-10-09T12:34:56.123456789Z', '2026-10-09T11:34:56.123456789Z', 'gt'],
  ])('keeps a precise one-hour estimate and clamps only underflow %s', (from, start, comparison) => {
    expect(estimatedEndLookback(from)).toEqual({ start, comparison });
  });

  it.each(['bad', '0000-12-31T23:59:59Z', '0001-01-01T00:00:00+01:00', '9999-12-31T23:59:59-01:00'])('refuses unsupported raw lookback %s', from => {
    expect(() => estimatedEndLookback(from)).toThrow();
  });

  it.each(['start', 'open', 'overlap'])('serializes %s filters through the SDK and retains the intended boundary rows', async kind => {
    const row = (id: string, start: string, end: string | null, allDay = false) => ({ id, starts_at: start, ends_at: end, all_day: allDay });
    const rows = [
      row('ongoing', '2026-10-09T11:00:00.000Z', '2026-10-09T12:30:00.000Z'),
      row('inside', '2026-10-09T12:00:00.000Z', '2026-10-09T12:30:00.000Z'),
      row('upper-edge', '2026-10-09T13:00:00.000Z', '2026-10-09T14:00:00.000Z'),
      row('point-before', '2026-10-09T11:59:00.000Z', '2026-10-09T11:59:00.000Z'),
      row('point-inside', '2026-10-09T12:15:00.000Z', '2026-10-09T12:15:00.000Z'),
      row('missing-exact-hour', '2026-10-09T11:00:00.000Z', null),
      row('missing-after-hour', '2026-10-09T11:00:00.001Z', null),
      row('missing-inside', '2026-10-09T12:15:00.000Z', null),
      row('all-current', '2026-10-09T00:00:00.000Z', null, true),
      row('all-ongoing', '2026-10-08T00:00:00.000Z', '2026-10-10T00:00:00.000Z', true),
      row('all-ended', '2026-10-08T00:00:00.000Z', '2026-10-09T00:00:00.000Z', true),
      row('all-upper-edge', '2026-10-10T00:00:00.000Z', null, true),
    ];
    const bounds = { timedFrom: '2026-10-09T12:00:00.000Z', timedTo: '2026-10-09T13:00:00.000Z', allDayFromDay: '2026-10-09', allDayToDay: '2026-10-10' };
    const filter = kind === 'start' ? calendarWindowFilter(bounds) : kind === 'open' ? calendarOpenWindowFilter(bounds) : calendarOverlapWindowFilter(bounds);
    const probe = sdk(rows);
    const result = await probe.db.from('calendar_events').select('*').eq('family_id', FAMILY).or(filter);
    expect(result.error).toBeNull();
    expect(result.data?.map(row => row.id)).toEqual(kind === 'start'
      ? ['inside', 'point-inside', 'missing-inside', 'all-current']
      : kind === 'open'
        ? ['inside', 'upper-edge', 'point-inside', 'missing-inside', 'all-current', 'all-upper-edge']
        : ['ongoing', 'inside', 'point-inside', 'missing-after-hour', 'missing-inside', 'all-current', 'all-ongoing']);
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0].searchParams.get('or')).toBe('(' + filter + ')');
  });

  it('uses no ambient current clock in any exported helper', () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Ambient clock is not a calendar bound'); });
    const bounds = briefingCalendarBounds('2026-10-09', 'UTC', 0, 1);
    expect(briefingCalendarWindow('2026-10-09', 'UTC', 0, 1)).toBe(calendarWindowFilter(bounds));
    expect(calendarOpenWindowFilter(bounds)).toContain('2026-10-09T00:00:00.000Z');
    expect(calendarOverlapWindowFilter(bounds)).toContain('2026-10-08T23:00:00.000Z');
    expect(estimatedEndLookback(bounds.timedFrom).comparison).toBe('gt');
    expect(instantCalendarBounds(bounds.timedFrom, '2026-10-09T12:00:00Z', 'UTC').allDayToDay).toBe('2026-10-10');
    expect(normalizeCalendarWindowInstant('2026-10-09')).toBe(bounds.timedFrom);
    expect(now).not.toHaveBeenCalled();
  });
});
