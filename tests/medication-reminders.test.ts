import { describe, it, expect } from 'vitest';
import { medicationDueReminders, type MedLite, type DoseLogLite } from '@/lib/notifications/medication-reminders';
import type { ScheduleLike } from '@/lib/medications/adherence';
import { asWallClockIn } from '@/lib/time/zoned';

// 2026-06-21 is a Sunday.
const now = new Date(2026, 5, 21, 11, 0);
const userByMember = new Map<string, string | null>([['kid', 'u-kid'], ['mom', 'u-mom']]);
const managers = [{ user_id: 'u-mom' }, { user_id: 'u-dad' }];

const med = (over: Partial<MedLite>): MedLite => ({ id: 'm1', name: 'Amoxicillin', dosage: '500 mg', member_id: 'kid', is_active: true, ...over });
const sched = (over: Partial<ScheduleLike>): ScheduleLike => ({
  id: 's1', medication_id: 'm1', time_of_day: '08:00', days_of_week: [0, 1, 2, 3, 4, 5, 6], starts_on: '2026-06-01', ends_on: null, ...over,
});

describe('medicationDueReminders', () => {
  it('notifies the assigned member for a pending dose today', () => {
    const out = medicationDueReminders([med({})], [sched({})], [], userByMember, managers, now);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'medication_due', related_type: 'medications', related_id: 'm1', user_id: 'u-kid' });
    expect(out[0].title).toBe('Medication due: Amoxicillin');
    expect(out[0].body).toContain('500 mg');
    expect(out[0].body).toContain('next at 08:00');
  });

  it('suppresses meds whose only dose today is already logged', () => {
    const doses: DoseLogLite[] = [{ schedule_id: 's1', scheduled_for: '2026-06-21T08:00', status: 'taken' }];
    expect(medicationDueReminders([med({})], [sched({})], doses, userByMember, managers, now)).toHaveLength(0);
  });

  it('counts multiple pending doses and reports the earliest time', () => {
    const schedules = [sched({ id: 's1', time_of_day: '20:00' }), sched({ id: 's2', time_of_day: '08:00' })];
    const out = medicationDueReminders([med({})], schedules, [], userByMember, managers, now);
    expect(out[0].body).toContain('2 doses today');
    expect(out[0].body).toContain('next at 08:00');
  });

  it('fans whole-family meds out to every manager', () => {
    const out = medicationDueReminders([med({ member_id: null })], [sched({})], [], userByMember, managers, now);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.user_id).sort()).toEqual(['u-dad', 'u-mom']);
  });

  it('skips inactive meds, meds without schedules, and non-matching weekdays', () => {
    expect(medicationDueReminders([med({ is_active: false })], [sched({})], [], userByMember, managers, now)).toHaveLength(0);
    expect(medicationDueReminders([med({})], [], [], userByMember, managers, now)).toHaveLength(0);
    // Schedule only on Mondays(1); 2026-06-21 is Sunday(0)
    expect(medicationDueReminders([med({})], [sched({ days_of_week: [1] })], [], userByMember, managers, now)).toHaveLength(0);
  });
});

// The reminder cron runs on the server's clock, which is UTC. A dose slot is a
// reading on the FAMILY's clock: a New York household's 08:00 pill is stored by
// the browser at 12:00Z. Resolve that slot on the runtime's clock instead and
// it lands at 08:00Z, matches no logged dose at all, and the family is told to
// take a pill it swallowed four hours ago.
describe('medicationDueReminders in a family zone', () => {
  const zone = 'America/New_York';
  const utcNow = new Date('2026-06-21T15:00:00.000Z'); // 11:00 Sunday in New York
  const takenAtEight: DoseLogLite[] = [{ schedule_id: 's1', scheduled_for: '2026-06-21T12:00:00.000Z', status: 'taken' }];

  it('recognises a dose the browser logged against the family clock', () => {
    const out = medicationDueReminders(
      [med({})], [sched({})], takenAtEight, userByMember, managers, asWallClockIn(utcNow, zone), zone,
    );
    expect(out).toHaveLength(0);
  });

  it('still reminds when that family clock has a dose genuinely outstanding', () => {
    const schedules = [sched({ id: 's1', time_of_day: '08:00' }), sched({ id: 's2', time_of_day: '20:00' })];
    const out = medicationDueReminders(
      [med({})], schedules, takenAtEight, userByMember, managers, asWallClockIn(utcNow, zone), zone,
    );
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain('1 dose today');
    expect(out[0].body).toContain('next at 20:00');
  });

  it('reads the runtime clock and nags for the taken dose when no zone is passed', () => {
    // The defect this zone argument exists to close — pinned so a caller that
    // drops the zone fails here rather than in a household's notification tray.
    expect(medicationDueReminders([med({})], [sched({})], takenAtEight, userByMember, managers, utcNow)).toHaveLength(1);
  });
});
