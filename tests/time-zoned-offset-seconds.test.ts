import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  asWallClockIn, asWallClockUtc, dayKeyIn, daysInMonth, instantForIcsLocalTime,
  instantForLocalTime, isValidTimezone, localPartsAt, startOfLocalDay,
  startOfNextLocalDay, zonedLocalToInstant,
} from '@/lib/time/zoned';
import { normalizeCalendarWindowInstant } from '@/lib/briefing/calendar-window';
import { searchEvents } from '@/lib/services/calendar';
import { parseExactInstant } from '@/lib/calendar/exact-instant';

// Synthetic instants and actual native Intl provide the independent wall-clock
// oracle. Supabase uses a read-only synthetic transport and supplied scope;
// this does not establish real Auth/RLS or production/provider execution.
const FAMILY = '10000000-0000-4000-8000-000000000001';
function clockParts(instant: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = formatter.formatToParts(instant);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return { year: parts.find(part => part.type === 'era')?.value === 'BC' ? 1 - get('year') : get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}
function sdk() {
  const calls: URL[] = [];
  const db = createClient('https://historical-offset.synthetic.invalid', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    expect(url.origin).toBe('https://historical-offset.synthetic.invalid');
    expect(url.pathname).toBe('/rest/v1/calendar_events');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(url.searchParams.get('family_id')).toBe('eq.' + FAMILY);
    return Response.json([], { headers: { 'content-range': '0-0/0' } });
  } } });
  return { db, calls };
}
afterEach(() => vi.restoreAllMocks());

describe('historical IANA seconds reach the exact civil reading', () => {
  it.each([
    [1, 1, 1, 0, 0, 'America/New_York'],
    [99, 1, 1, 12, 30, 'America/New_York'],
    [1900, 1, 1, 12, 30, 'Asia/Kathmandu'],
    [1850, 1, 1, 12, 30, 'Europe/Paris'],
    [1900, 1, 1, 12, 30, 'Africa/Monrovia'],
  ] as const)('resolves %i-%i-%i %i:%i in %s without borrowing a minute', (year, month, day, hour, minute, zone) => {
    const expected = { year, month, day, hour, minute, second: 0 };
    for (const resolver of [zonedLocalToInstant, instantForLocalTime, instantForIcsLocalTime]) {
      const at = resolver(year, month, day, hour * 60 + minute, zone);
      expect(at).not.toBeNull();
      expect(clockParts(at!, zone)).toEqual(expected);
      expect(at!.getUTCMilliseconds()).toBe(0);
    }
  });

  it.each([
    ['0001-01-01T00:00:42', 'America/New_York', '0001-01-01T04:56:44.000Z'],
    ['0099-01-01T12:30:42', 'America/New_York', '0099-01-01T17:26:44.000Z'],
    ['1900-01-01T12:30:42', 'Asia/Kathmandu', '1900-01-01T06:49:26.000Z'],
  ])('normalizes historical wall seconds through the actual shared resolver: %s', (input, zone, expected) => {
    const normalized = normalizeCalendarWindowInstant(input, zone);
    expect(normalized).toBe(expected);
    expect(clockParts(new Date(normalized), zone)).toMatchObject({ hour: Number(input.slice(11, 13)), minute: Number(input.slice(14, 16)), second: Number(input.slice(17, 19)) });
  });

  it.each(Array.from({ length: 10 }, (_, digits) => digits))('retains fractional unit length %i with historical second offsets', digits => {
    for (const fraction of digits === 0 ? [''] : ['0'.repeat(digits), '1'.padEnd(digits, '0')]) {
      const input = '1900-01-01T12:30:42' + (fraction ? '.' + fraction : '');
      const expected = '1900-01-01T06:49:26.' + fraction.padEnd(Math.max(3, digits), '0') + 'Z';
      const normalized = normalizeCalendarWindowInstant(input, 'Asia/Kathmandu');
      expect(normalized).toBe(expected);
      expect(parseExactInstant(normalized)).toBe(parseExactInstant(expected));
    }
  });

  it.each([
    ['0001-01-01T00:00:42.000001', 'America/New_York', '0001-01-01T04:56:44.000001Z'],
    ['0099-01-01T12:30:42.000000001', 'America/New_York', '0099-01-01T17:26:44.000000001Z'],
    ['1900-01-01T12:30:42.123456789', 'Asia/Kathmandu', '1900-01-01T06:49:26.123456789Z'],
  ])('sends the exact normalized historical clock through the installed SDK: %s', async (from, tz, expected) => {
    const probe = sdk();
    const scope = { db: probe.db, familyId: FAMILY, userId: 'synthetic-user', memberId: 'synthetic-member', role: 'parent' as const, actorKind: 'member' as const, tz };
    expect(await searchEvents(scope, { from, expandSeries: false })).toMatchObject({ ok: true, data: [] });
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0].searchParams.get('starts_at')).toBe('gte.' + expected);
  });

  it.each(['0001-01-01T00:00', '0001-01-01T00:00:42.000001', '0001-01-01T00:00:00+01:00'])('keeps canonical AD1 refusal before SDK: %s', async from => {
    const probe = sdk();
    const scope = { db: probe.db, familyId: FAMILY, userId: 'synthetic-user', memberId: 'synthetic-member', role: 'parent' as const, actorKind: 'member' as const, tz: 'Asia/Tokyo' };
    expect(await searchEvents(scope, { from, expandSeries: false })).toMatchObject({ ok: false });
    expect(probe.calls).toEqual([]);
  });
});

describe('unchanged public resolver contracts', () => {
  it('keeps the exact public LocalParts shape without second or offset fields', () => {
    const parts = localPartsAt(new Date('2026-10-09T12:30:42.123Z'), 'America/New_York');
    expect(parts).toEqual({ year: 2026, month: 10, day: 9, hour: 8, minute: 30 });
    expect(Object.keys(parts).sort()).toEqual(['day', 'hour', 'minute', 'month', 'year']);
  });

  it.each([
    [2026, 3, 8, 2, 30, 'America/New_York', '2026-03-08T07:30:00.000Z', '2026-03-08T07:00:00.000Z'],
    [2026, 10, 4, 2, 15, 'Australia/Lord_Howe', '2026-10-03T15:45:00.000Z', '2026-10-03T15:30:00.000Z'],
  ] as const)('retains distinct RFC gap and routine-forward choices in %s', (year, month, day, hour, minute, zone, rfc, routine) => {
    expect(zonedLocalToInstant(year, month, day, hour * 60 + minute, zone)).toBeNull();
    expect(instantForIcsLocalTime(year, month, day, hour * 60 + minute, zone)?.toISOString()).toBe(rfc);
    expect(instantForLocalTime(year, month, day, hour * 60 + minute, zone)?.toISOString()).toBe(routine);
  });

  it.each([
    [2026, 11, 1, 1, 30, 'America/New_York', '2026-11-01T05:30:00.000Z'],
    [2026, 10, 25, 1, 30, 'Europe/London', '2026-10-25T00:30:00.000Z'],
    [2026, 4, 5, 1, 45, 'Australia/Lord_Howe', '2026-04-04T14:45:00.000Z'],
  ] as const)('keeps RFC earliest fold in %s', (year, month, day, hour, minute, zone, expected) => {
    expect(instantForIcsLocalTime(year, month, day, hour * 60 + minute, zone)?.toISOString()).toBe(expected);
  });

  it.each([
    [1880, 'Asia/Colombo', '1879-12-31T18:40:36.000Z', 8, '1879-12-31T18:41:28.000Z'],
    [1890, 'America/Caracas', '1890-01-01T04:27:44.000Z', 4, '1890-01-01T04:28:40.000Z'],
  ] as const)('distinguishes a historical second-only gap from an exact midnight in %s', (year, zone, rfc, gapSeconds, routine) => {
    expect(zonedLocalToInstant(year, 1, 1, 0, zone)).toBeNull();
    const imported = instantForIcsLocalTime(year, 1, 1, 0, zone);
    expect(imported?.toISOString()).toBe(rfc);
    expect(clockParts(imported!, zone)).toMatchObject({ year, month: 1, day: 1, hour: 0, minute: 0, second: gapSeconds });
    const scheduled = instantForLocalTime(year, 1, 1, 0, zone);
    expect(scheduled?.toISOString()).toBe(routine);
    expect(clockParts(scheduled!, zone)).toMatchObject({ year, month: 1, day: 1, hour: 0, minute: 1, second: 0 });
  });

  it('retains a skipped whole date RFC interpretation while the routine cannot schedule it', () => {
    expect(instantForIcsLocalTime(2011, 12, 30, 9 * 60, 'Pacific/Apia')?.toISOString()).toBe('2011-12-30T19:00:00.000Z');
    expect(instantForLocalTime(2011, 12, 30, 9 * 60, 'Pacific/Apia')).toBeNull();
  });

  it.each([1, 4, 99, 100, 2026, 9999])('retains Gregorian year %i during both constructor passes', year => {
    const expected = `${String(year).padStart(4, '0')}-12-30T09:30:00.000Z`;
    expect(zonedLocalToInstant(year, 12, 30, 570, 'UTC')?.toISOString()).toBe(expected);
    expect(instantForIcsLocalTime(year, 12, 30, 570, 'UTC')?.toISOString()).toBe(expected);
    expect(daysInMonth(year, 2)).toBe(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28);
  });

  it.each([[2026, 13, 1], [2026, 2, 30], [2026, 1, 0]] as const)('does not broaden strict civil input admission %i-%i-%i', (year, month, day) => {
    expect(zonedLocalToInstant(year, month, day, 9 * 60, 'UTC')).toBeNull();
  });

  it.each(['2026-03-08T16:00:00Z', '2026-11-01T16:00:00Z'])('retains local day duration on DST date %s', input => {
    const instant = new Date(input);
    const first = startOfLocalDay(instant, 'America/New_York');
    const next = startOfNextLocalDay(instant, 'America/New_York');
    expect(next.getTime() - first.getTime()).toBe(input.startsWith('2026-03') ? 23 * 3_600_000 : 25 * 3_600_000);
    expect(clockParts(first, 'America/New_York')).toMatchObject({ hour: 0, minute: 0, second: 0 });
  });

  it('preserves unusable-zone and reader-clock fallback behavior', () => {
    const instant = new Date('2026-10-09T12:30:42.123Z');
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('Asia/Kathmandu')).toBe(true);
    expect(dayKeyIn(instant, 'Not/AZone')).toBe('2026-10-09');
    const midnight = new Date(instant); midnight.setHours(0, 0, 0, 0);
    expect(startOfLocalDay(instant, 'Not/AZone').getTime()).toBe(midnight.getTime());
    expect(startOfNextLocalDay(instant, 'Not/AZone').getTime()).toBe(midnight.getTime() + 86_400_000);
    expect(() => instantForIcsLocalTime(2026, 10, 9, 570, 'Not/AZone')).toThrow();
  });

  it('retains minute-only wall bridges and makes no ambient clock read', () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Unexpected current-clock dependency'); });
    const instant = new Date('2026-10-09T12:30:42.123Z');
    expect(asWallClockUtc(instant, 'Asia/Kathmandu').toISOString()).toBe('2026-10-09T18:15:00.000Z');
    const local = asWallClockIn(instant, 'Asia/Kathmandu');
    expect([local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds()]).toEqual([2026, 10, 9, 18, 15, 0, 0]);
    expect(dayKeyIn(instant, 'Asia/Kathmandu')).toBe('2026-10-09');
    expect(now).not.toHaveBeenCalled();
  });
});
