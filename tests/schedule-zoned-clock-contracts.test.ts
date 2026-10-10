import { afterEach, describe, expect, it, vi } from 'vitest';
import { clockInZone, dayKeyInZone, todayInZone, zonedTimeMs } from '@/lib/schedule/zoned';

// These are pure helper contracts using synthetic instants. Related caller
// suites cover their existing composition; this file makes no Auth/RLS,
// provider, browser, or production-reachability claim.
describe('schedule clock formatting', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('returns empty for a non-finite clock %s', ms => {
    expect(clockInZone(ms, 'UTC')).toBe('');
    expect(clockInZone(ms, 'Not/AZone')).toBe('');
  });

  it.each([8_640_000_000_000_001, -8_640_000_000_000_001, 1e30, -1e30])('returns empty when a finite clock cannot construct a Date: %s', ms => {
    expect(clockInZone(ms, 'UTC')).toBe('');
    expect(clockInZone(ms, 'Not/AZone')).toBe('');
    expect(dayKeyInZone(ms, 'UTC')).toBeNull();
  });

  it.each(['2026-10-09T12:30:00Z', '1791549000000', 'bad', '', null, undefined])('does not coerce runtime input %s to a clock', ms => {
    expect(clockInZone(ms as unknown as number, 'UTC')).toBe('');
  });

  it.each([
    ['UTC', '12:30 PM'],
    ['America/Los_Angeles', '5:30 AM'],
    ['Asia/Tokyo', '9:30 PM'],
    ['Asia/Kathmandu', '6:15 PM'],
    ['Australia/Lord_Howe', '11:30 PM'],
  ])('formats the family clock in %s without seconds', (zone, expected) => {
    expect(clockInZone(Date.parse('2026-10-09T12:30:59.999Z'), zone)).toBe(expected);
  });

  it.each(['Not/AZone', '', 'Mars/Olympus'])('keeps a padded UTC minute fallback for unusable IANA zone %s', zone => {
    expect(clockInZone(Date.parse('2026-10-09T00:05:59.999Z'), zone)).toBe('00:05');
    expect(clockInZone(Date.parse('2026-10-09T12:30:00.001Z'), zone)).toBe('12:30');
  });

  it.each([
    ['0001-01-01T12:30:59.999Z', '12:30'],
    ['0099-01-01T00:05:00.001Z', '00:05'],
    ['9999-12-31T23:59:59.999Z', '23:59'],
    ['+010000-01-01T12:30:59.999Z', '12:30'],
    ['-000001-01-01T12:30:59.999Z', '12:30'],
    ['+275760-09-13T00:00:00.000Z', '00:00'],
    ['-271821-04-20T00:00:00.000Z', '00:00'],
  ])('preserves a valid Date clock across ISO year spelling %s', (iso, expected) => {
    const ms = Date.parse(iso);
    expect(Number.isFinite(ms)).toBe(true);
    expect(clockInZone(ms, 'Not/AZone')).toBe(expected);
    expect(clockInZone(ms, 'UTC')).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
  });

  it('keeps distinct instants in the repeated hour on the same wall clock', () => {
    expect(clockInZone(Date.parse('2026-11-01T05:30:00Z'), 'America/New_York')).toBe('1:30 AM');
    expect(clockInZone(Date.parse('2026-11-01T06:30:00Z'), 'America/New_York')).toBe('1:30 AM');
  });
});

describe('unchanged neighboring schedule exports', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['0001-01-01', '0099-12-31', '9999-12-31'])('retains supported day key %s and UTC fallback', key => {
    const ms = Date.parse(key + 'T12:30:00Z');
    expect(dayKeyInZone(ms, 'UTC')).toBe(key);
    expect(dayKeyInZone(ms, 'Not/AZone')).toBe(key);
    expect(zonedTimeMs(key, 12, 30, 'UTC')).toBe(ms);
    expect(zonedTimeMs(key, 12, 30, 'Not/AZone')).toBe(ms);
  });

  it.each(['0000-12-31T12:30:00Z', '+010000-01-01T12:30:00Z', '-000001-01-01T12:30:00Z'])('does not turn unsupported era %s into a supported day', iso => {
    expect(dayKeyInZone(Date.parse(iso), 'UTC')).toBeNull();
    expect(dayKeyInZone(Date.parse(iso), 'Not/AZone')).toBeNull();
  });

  it('refuses a projected day outside the supported AD range', () => {
    expect(dayKeyInZone(Date.parse('0001-01-01T00:00:00Z'), 'America/New_York')).toBeNull();
    expect(dayKeyInZone(Date.parse('9999-12-31T23:59:59Z'), 'Asia/Tokyo')).toBeNull();
  });

  it.each(['', 'bad', '2026-13-01', '2026-01-32'])('keeps malformed day-string %s unparseable', key => {
    expect(zonedTimeMs(key, 12, 30, 'UTC')).toBeNaN();
    expect(zonedTimeMs(key, 12, 30, 'Not/AZone')).toBeNaN();
  });

  it('retains family-local midnight, offset minutes and precision', () => {
    expect(zonedTimeMs('2026-10-09', 0, 5, 'Asia/Kathmandu')).toBe(Date.parse('2026-10-08T18:20:00Z'));
    expect(zonedTimeMs('2026-10-09', 0, 5, 'America/Los_Angeles')).toBe(Date.parse('2026-10-09T07:05:00Z'));
    expect(zonedTimeMs('2026-10-09', 0, 5, 'UTC') % 60_000).toBe(0);
  });

  it('retains the existing two-pass spring-gap and autumn-fold policy', () => {
    // This deliberately pins the existing two-pass rule; it does not claim
    // that the helper exposes a strict civil-time/fold disambiguation API.
    expect(zonedTimeMs('2026-03-08', 2, 30, 'America/New_York')).toBe(Date.parse('2026-03-08T06:30:00Z'));
    expect(zonedTimeMs('2026-11-01', 1, 30, 'America/New_York')).toBe(Date.parse('2026-11-01T05:30:00Z'));
  });

  it('uses an explicit today clock without reading the ambient clock', () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Unexpected ambient clock read'); });
    const ms = Date.parse('2026-10-09T01:30:00Z');
    expect(todayInZone('America/Los_Angeles', ms)).toBe('2026-10-08');
    expect(todayInZone('Not/AZone', ms)).toBe('2026-10-09');
    expect(now).not.toHaveBeenCalled();
  });

  it('reads the current clock only when today has no supplied instant', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-09T01:30:00Z'));
    expect(todayInZone('America/Los_Angeles')).toBe('2026-10-08');
    expect(todayInZone('UTC', undefined)).toBe('2026-10-09');
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('does not read the ambient clock for the three mandatory-clock helpers', () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Unexpected ambient clock read'); });
    const ms = Date.parse('2026-10-09T12:30:00Z');
    expect(clockInZone(ms, 'UTC')).toBe('12:30 PM');
    expect(dayKeyInZone(ms, 'UTC')).toBe('2026-10-09');
    expect(zonedTimeMs('2026-10-09', 12, 30, 'UTC')).toBe(ms);
    expect(now).not.toHaveBeenCalled();
  });
});
