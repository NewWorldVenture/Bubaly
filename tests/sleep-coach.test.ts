import { describe, expect, it } from 'vitest';
import {
  SLEEP_SOURCES, averageDuration, consistencyScore, durationMinutes, fmtHours, habitCorrelations, minutesOfDay, recentLogs,
  recommendedSleepHours, routineAdherence, routineStepIdeas, sleepDebtMinutes, sleepSummary, sleepTrend, timeToMinutes, weeklyProgram,
  type CheckinLike, type SleepLogLike,
} from '@/lib/sleep/coach';

const TODAY = new Date('2026-09-05T09:00:00');
function night(daysAgo: number, bedHour: number, hours: number, extra: Partial<SleepLogLike> = {}): SleepLogLike {
  const d = new Date(TODAY); d.setDate(d.getDate() - daysAgo);
  const date = d.toISOString().slice(0, 10);
  const bed = new Date(d); bed.setDate(bed.getDate() - 1); bed.setHours(bedHour, 0, 0, 0);
  const wake = new Date(bed.getTime() + hours * 3600_000);
  return { member_id: 'kid', sleep_date: date, bedtime: bed.toISOString(), wake_time: wake.toISOString(), duration_min: hours * 60, quality: 3, awakenings: 0, ...extra };
}

describe('targets + helpers', () => {
  it('gives age-aware targets and routine ideas', () => {
    expect(recommendedSleepHours(6)).toMatchObject({ min: 9, max: 12, label: 'school age' });
    expect(recommendedSleepHours(15).label).toBe('teen');
    expect(recommendedSleepHours(null).min).toBe(7);
    expect(recommendedSleepHours(70).max).toBe(8);
    expect(routineStepIdeas(4)[0]).toBe('Bath');
    expect(routineStepIdeas(40)[0]).toContain('Dim lights');
    expect(SLEEP_SOURCES).toHaveLength(3);
  });
  it('computes durations, minutes-of-day with after-midnight handling, and formats', () => {
    expect(durationMinutes('2026-09-04T21:30:00', '2026-09-05T06:45:00')).toBe(555);
    expect(durationMinutes('2026-09-05T06:45:00', '2026-09-04T21:30:00')).toBe(0);
    expect(minutesOfDay('2026-09-04T21:30:00')).toBe(21 * 60 + 30);
    expect(minutesOfDay('2026-09-05T00:30:00')).toBe(24 * 60 + 30);
    expect(timeToMinutes('21:00')).toBe(1260);
    expect(timeToMinutes('01:00')).toBe(1500);
    expect(fmtHours(555)).toBe('9h 15m');
  });
});

describe('analytics', () => {
  // sleep_date is the night that ENDED that morning: 0 = last night. A week is days 0..6.
  const logs = [night(0, 21, 9), night(1, 21, 8.5), night(2, 22, 7.5), night(3, 21, 9.5), night(4, 20, 10), night(5, 21, 9), night(6, 21, 8), night(8, 23, 6)];
  it('selects recent nights newest first and averages them', () => {
    const week = recentLogs(logs, 'kid', TODAY, 7);
    expect(week).toHaveLength(7);
    expect(week[0].sleep_date > week[1].sleep_date).toBe(true);
    expect(averageDuration(week)).toBe(Math.round(((9 + 8.5 + 7.5 + 9.5 + 10 + 9 + 8) * 60) / 7));
    expect(averageDuration([])).toBeNull();
  });
  it('accumulates debt only on short nights and scores consistency', () => {
    expect(sleepDebtMinutes([night(0, 21, 8), night(1, 21, 10)], 9)).toBe(60);
    expect(consistencyScore([night(0, 21, 9), night(1, 21, 9)])).toBe(100);
    expect(consistencyScore([night(0, 20, 9), night(1, 23, 9)])).toBe(0);
    expect(consistencyScore([night(0, 21, 9)])).toBeNull();
  });
  it('measures routine adherence within 30 minutes on routine days', () => {
    const routine = { member_id: 'kid', target_bedtime: '21:00', target_wake: '07:00', is_active: true, days_of_week: [0, 1, 2, 3, 4, 5, 6] };
    expect(routineAdherence(routine, [night(0, 21, 9), night(1, 22, 9), night(2, 21, 9)])).toBe(67);
    expect(routineAdherence(null, logs)).toBeNull();
    expect(routineAdherence({ ...routine, days_of_week: [] }, logs)).toBeNull();
  });
  it('detects trend direction', () => {
    expect(sleepTrend([night(0, 21, 10), night(1, 21, 10), night(2, 21, 10), night(3, 21, 8), night(4, 21, 8), night(5, 21, 8), night(6, 21, 8)])).toBe('improving');
    expect(sleepTrend([night(0, 21, 7), night(1, 21, 7), night(2, 21, 7), night(3, 21, 9), night(4, 21, 9), night(5, 21, 9), night(6, 21, 9)])).toBe('slipping');
    expect(sleepTrend([night(0, 21, 9), night(1, 21, 9), night(2, 21, 9), night(3, 21, 9), night(4, 21, 9.25), night(5, 21, 9), night(6, 21, 9)])).toBe('steady');
    expect(sleepTrend(logs.slice(0, 2))).toBe('unknown');
  });
  it('correlates check-in habits with sleep from the member’s own nights', () => {
    const nights = [night(0, 21, 9), night(1, 21, 7), night(2, 21, 9), night(3, 21, 7)];
    const checkins: CheckinLike[] = nights.map((n, i) => ({ member_id: 'kid', checkin_date: n.sleep_date, energy: 3, mood: 3, caffeine_after_2pm: false, screens_in_bed: i % 2 === 1, exercised: i % 2 === 0 }));
    const c = habitCorrelations(nights, checkins);
    expect(c.find((x) => x.factor === 'Screens in bed')).toMatchObject({ withFactor: 420, withoutFactor: 540, deltaMinutes: -120, nights: 4 });
    expect(c.find((x) => x.factor === 'Caffeine after 2pm')?.withFactor).toBeNull();
  });
});

describe('summary + program', () => {
  it('summarises a short week and builds a 7-step program that shifts bedtime', () => {
    const logs = [night(0, 22, 7), night(1, 22, 7.5), night(2, 22, 7), night(3, 22, 7.5), night(4, 22, 7), night(5, 22, 7), night(6, 22, 7)];
    const routine = { member_id: 'kid', target_bedtime: '21:00', target_wake: '07:00', is_active: true, days_of_week: [0, 1, 2, 3, 4, 5, 6] };
    const s = sleepSummary(logs, routine, 8, TODAY, 'kid');
    expect(s.status).toBe('short');
    expect(s.nights).toBe(7);
    expect(s.text).toMatch(/short this week/);
    expect(s.adherence).toBe(0);
    const program = weeklyProgram(s, habitCorrelations(logs, []), routine);
    expect(program).toHaveLength(7);
    expect(program[0].title).toBe('Fix the wake time at 07:00');
    expect(program.filter((p) => p.title.includes('15 minutes earlier')).length).toBeGreaterThan(0);
    expect(program[6].title).toBe('Review the week');
  });
  it('reports on-track and no-data states', () => {
    const good = sleepSummary([night(0, 21, 10), night(1, 21, 10)], null, 8, TODAY, 'kid');
    expect(good.status).toBe('on_track');
    expect(good.text).toContain('on track for 9–12h');
    expect(sleepSummary([], null, 8, TODAY, 'kid').text).toBe('No nights logged this week');
    const steps = weeklyProgram(good, [{ factor: 'Screens in bed', withFactor: 400, withoutFactor: 540, deltaMinutes: -140, nights: 6 }], null);
    expect(steps[2].title).toBe('Drop “screens in bed”');
  });
});
