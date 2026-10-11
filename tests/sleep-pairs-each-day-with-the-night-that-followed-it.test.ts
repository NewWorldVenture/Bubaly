import { describe, expect, it } from 'vitest';
import { bedtimeEvening, habitCorrelations, routineAdherence, type CheckinLike, type SleepLogLike } from '@/lib/sleep/coach';

// A night is filed under the morning it ENDED: LogForm sets `sleep_date` from
// the wake time (sleep-module.tsx). A check-in records THAT DAY's habits
// ("Today's habits, so the coach can see what moves your nights"), and a
// routine's days_of_week are its "Nights" — bedtime evenings.
//
// H9 — habitCorrelations joined check-in D to the night filed under D, which
// ended on the morning of D, before the habits happened: Tuesday afternoon's
// coffee was scored against Monday night.
//
// H10 — routineAdherence matched days_of_week against the weekday of
// `sleep_date`, the wake-up morning: a Sun–Thu school-night routine dropped
// Thursday night and scored Saturday night against the school-night bedtime.

/** The day before a `YYYY-MM-DD`, computed here rather than with the code under test. */
const dayBefore = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const night = (sleepDate: string, minutes: number, bedtime = `${dayBefore(sleepDate)}T21:00:00Z`): SleepLogLike => ({
  member_id: 'kid', sleep_date: sleepDate, bedtime, wake_time: `${sleepDate}T07:00:00Z`, duration_min: minutes, quality: 3, awakenings: 0,
});
const checkin = (day: string, habits: Partial<CheckinLike>): CheckinLike => ({
  member_id: 'kid', checkin_date: day, energy: 3, mood: 3, caffeine_after_2pm: false, screens_in_bed: false, exercised: false, ...habits,
});

describe('a day\'s habits are scored against the night that followed them (H9)', () => {
  it('Tuesday\'s late coffee is credited to Tuesday night, filed under Wednesday', () => {
    // Monday night (filed Tue 2026-10-06) was a good one; Tuesday night (filed
    // Wed 2026-10-07), after the coffee, was short.
    const nights = [night('2026-10-06', 540), night('2026-10-07', 360)];
    const checkins = [checkin('2026-10-06', { caffeine_after_2pm: true }), checkin('2026-10-05', { caffeine_after_2pm: false })];

    const caffeine = habitCorrelations(nights, checkins).find((c) => c.factor === 'Caffeine after 2pm')!;

    expect(caffeine).toMatchObject({ withFactor: 360, withoutFactor: 540, deltaMinutes: -180, nights: 2 });
  });

  it('a check-in dated the same as a night\'s sleep_date is not that night\'s', () => {
    // The only check-in is Wednesday's; the only night ended Wednesday morning.
    const result = habitCorrelations([night('2026-10-07', 360)], [checkin('2026-10-07', { exercised: true })]);
    expect(result.every((c) => c.nights === 0)).toBe(true);
  });

  it('the evening before a date crosses month and year ends', () => {
    expect(bedtimeEvening('2026-11-01')).toBe('2026-10-31');
    expect(bedtimeEvening('2027-01-01')).toBe('2026-12-31');
    expect(bedtimeEvening('2028-03-01')).toBe('2028-02-29');
  });
});

describe('a routine\'s nights are bedtime evenings (H10)', () => {
  // Sun–Thu school nights, 21:00.
  const schoolNights = { member_id: 'kid', target_bedtime: '21:00', target_wake: '07:00', is_active: true, days_of_week: [0, 1, 2, 3, 4] };

  it('Thursday night (filed under Friday) is a school night and counts', () => {
    // Thu 2026-10-08 at 21:00, woke Fri 2026-10-09.
    expect(routineAdherence(schoolNights, [night('2026-10-09', 600)], 'UTC')).toBe(100);
  });

  it('Saturday night (filed under Sunday) is not, and is not scored against the school-night bedtime', () => {
    // Sat 2026-10-10 at 23:30, woke Sun 2026-10-11: off-routine, so no score at all.
    expect(routineAdherence(schoolNights, [night('2026-10-11', 480, '2026-10-10T23:30:00Z')], 'UTC')).toBeNull();
  });

  it('an after-midnight bedtime still belongs to the evening before', () => {
    // Out late on Thursday: asleep 00:30 Friday, woke Friday. Thursday is a
    // school night, and 00:30 is far from 21:00.
    expect(routineAdherence(schoolNights, [night('2026-10-09', 390, '2026-10-09T00:30:00Z')], 'UTC')).toBe(0);
  });

  it('a whole week counts exactly the five school nights', () => {
    const week = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'].map((d) => night(d, 540));
    // Mornings Mon..Sun → evenings Sun..Sat: Sun–Thu are the first five, all on time.
    expect(routineAdherence(schoolNights, week, 'UTC')).toBe(100);
    const lateWeekend = week.map((n, i) => (i >= 5 ? night(n.sleep_date, 480, `${dayBefore(n.sleep_date)}T23:45:00Z`) : n));
    expect(routineAdherence(schoolNights, lateWeekend, 'UTC')).toBe(100);
  });
});
