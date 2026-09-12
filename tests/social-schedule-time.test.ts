import { describe, expect, it } from 'vitest';
import { formatScheduledTime, resolveScheduleTime, scheduleDisplayTimezone, scheduleTimezone, scheduledDay, scheduleStatusKey, validateScheduleInstant } from '@/lib/social/schedule-time';

const now = Date.parse('2026-01-01T00:00:00Z');
describe('explicit social schedule time', () => {
  it.each([
    ['2026-09-13T09:00', 'America/New_York', '2026-09-13T13:00:00.000Z'],
    ['2026-01-13T09:00', 'America/New_York', '2026-01-13T14:00:00.000Z'],
    ['2026-09-13T09:00', 'Asia/Kathmandu', '2026-09-13T03:15:00.000Z'],
    ['2026-09-13T00:00', 'Pacific/Kiritimati', '2026-09-12T10:00:00.000Z'],
    ['2026-09-13T09:00', 'UTC', '2026-09-13T09:00:00.000Z'],
    ['2028-02-29T09:00', 'Europe/Paris', '2028-02-29T08:00:00.000Z'],
  ])('resolves %s in %s to one absolute instant', (local, zone, instant) => {
    expect(resolveScheduleTime(local, zone, now)).toMatchObject({ ok: true, scheduledFor: instant });
  });
  it.each([
    ['2026-03-08T02:30', 'America/New_York'],
    ['2026-11-01T01:30', 'America/New_York'],
    ['2026-04-05T01:45', 'Australia/Lord_Howe'],
    ['2026-10-04T02:15', 'Australia/Lord_Howe'],
  ])('rejects skipped or repeated clock time %s %s', (local, zone) => {
    expect(resolveScheduleTime(local, zone, now)).toEqual({ ok: false, key: 'socialSchedule.clockChange' });
  });
  it.each(['2026-02-30T09:00', '2026-02-29T09:00', '2026-01-01T24:00', '2026-13-01T09:00', '', '2026-09-13T09:00Z'])('rejects invalid wall input %s', local => {
    expect(resolveScheduleTime(local, 'UTC', now)).toEqual({ ok: false, key: 'socialSchedule.invalidTime' });
  });
  it.each(['', 'Not/AZone', '+05:00', ' UTC ', 'x'.repeat(101)])('rejects invalid zone %s', zone => {
    expect(scheduleTimezone(zone)).toBeNull();
    expect(validateScheduleInstant('2026-09-13T09:00:00Z', zone, now)).toEqual({ ok: false, key: 'socialSchedule.invalidZone' });
  });
  it('rejects past and exactly-now times on both sides of the action', () => {
    expect(resolveScheduleTime('2026-01-01T00:00', 'UTC', now)).toMatchObject({ ok: false, key: 'socialSchedule.pastTime' });
    expect(validateScheduleInstant('2025-12-31T23:59:00Z', 'UTC', now)).toMatchObject({ ok: false, key: 'socialSchedule.pastTime' });
  });
  it('accepts canonical milliseconds or explicit whole-second Z input', () => {
    for (const value of ['2026-09-13T09:00:00Z', '2026-09-13T09:00:00.000Z']) {
      expect(validateScheduleInstant(value, 'America/New_York', now)).toEqual({ ok: true, scheduledFor: '2026-09-13T09:00:00.000Z', timezone: 'America/New_York' });
    }
  });
  it.each(['2026-09-13T09:00', '2026-02-30T09:00:00Z', '2026-09-13T24:00:00Z', '2026-09-13T09:00:00+04:00', '2026-09-13T09:00:60Z'])('server rejects normalized or offset-free contract %s', value => {
    expect(validateScheduleInstant(value, 'UTC', now)).toMatchObject({ ok: false, key: 'socialSchedule.invalidTime' });
  });
  it('shows persisted timezone or explicit UTC for legacy rows', () => {
    expect(scheduleDisplayTimezone({ schedule_timezone: 'America/New_York' })).toBe('America/New_York');
    expect(scheduleDisplayTimezone({ schedule_timezone: 'not-a-zone' })).toBe('UTC');
    expect(scheduleDisplayTimezone(null)).toBe('UTC');
    expect(formatScheduledTime('2026-09-13T13:00:00Z', 'America/New_York')).toBe('13 Sept 2026, 09:00 (America/New_York)');
    expect(formatScheduledTime('2026-09-13T13:00:00Z', 'America/New_York', 'fr-FR')).toBe('13 sept. 2026, 09:00 (America/New_York)');
    expect(scheduledDay('2026-09-13T01:00:00Z', 'America/New_York')).toBe('2026-09-12');
    expect(scheduledDay('2026-09-13T01:00:00Z', 'UTC')).toBe('2026-09-13');
    expect(scheduledDay('invalid', 'UTC')).toBeNull();
  });
  it('renders only recognized schedule diagnostics and labels old rows as unverified', () => {
    expect(scheduleStatusKey(null)).toBe('socialSchedule.legacyUnverified');
    expect(scheduleStatusKey({ schedule_phase: 'approval_required' })).toBe('socialSchedule.approvalRequired');
    expect(scheduleStatusKey({ schedule_phase: 'unknown' })).toBe('socialSchedule.awaitingConfirmation');
    expect(scheduleStatusKey({ schedule_phase: 'completed' })).toBe('');
    expect(scheduleStatusKey({ schedule_phase: 'failed', schedule_error: 'socialSchedule.reconnectRequired' })).toBe('socialSchedule.reconnectRequired');
    expect(scheduleStatusKey({ schedule_phase: 'failed', schedule_error: 'private error details' })).toBe('socialSchedule.changed');
  });
});
