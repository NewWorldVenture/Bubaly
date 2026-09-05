// lib/sleep/coach.ts — pure, deterministic sleep-coach engine.
//
// The differentiator: age-aware targets for every member (a 6-year-old and a
// parent need very different nights), sleep debt and consistency computed from
// the family's OWN logs, routine adherence, and a behavioural 7-day program
// that works without any AI — the AI coach then narrates and personalises it.

import type { SleepSource } from '@/lib/database.types';

export const SLEEP_SOURCES: { value: SleepSource; label: string }[] = [
  { value: 'manual', label: 'Logged by hand' }, { value: 'wearable', label: 'Wearable' }, { value: 'estimate', label: 'Estimate' },
];

/** Recommended nightly sleep (hours) by age — AASM consensus bands. */
export function recommendedSleepHours(age: number | null): { min: number; max: number; label: string } {
  if (age === null) return { min: 7, max: 9, label: 'adult' };
  if (age < 1) return { min: 12, max: 16, label: 'infant' };
  if (age < 3) return { min: 11, max: 14, label: 'toddler' };
  if (age < 6) return { min: 10, max: 13, label: 'preschooler' };
  if (age < 13) return { min: 9, max: 12, label: 'school age' };
  if (age < 18) return { min: 8, max: 10, label: 'teen' };
  if (age < 65) return { min: 7, max: 9, label: 'adult' };
  return { min: 7, max: 8, label: 'older adult' };
}

/** Bedtime routine step ideas by age band. */
export function routineStepIdeas(age: number | null): string[] {
  if (age !== null && age < 6) return ['Bath', 'Pyjamas + teeth', 'Two books', 'Song + lights out'];
  if (age !== null && age < 13) return ['Screens off', 'Shower + teeth', 'Read 20 minutes', 'Lights out'];
  if (age !== null && age < 18) return ['Phone charges outside the room', 'Shower', 'Read or journal', 'Lights out'];
  return ['Dim lights + screens off', 'Tomorrow’s list written down', 'Stretch or read', 'Lights out'];
}

export type SleepLogLike = { member_id: string; sleep_date: string; bedtime: string; wake_time: string; duration_min: number; quality: number | null; awakenings: number };
export type RoutineLike = { member_id: string; target_bedtime: string; target_wake: string; is_active: boolean; days_of_week: number[] };
export type CheckinLike = { member_id: string; checkin_date: string; energy: number; mood: number; caffeine_after_2pm: boolean; screens_in_bed: boolean; exercised: boolean };

const DAY_MS = 86_400_000;
const dateOnly = (v: string | Date) => (typeof v === 'string' ? new Date(`${v.slice(0, 10)}T00:00:00`) : new Date(v.getFullYear(), v.getMonth(), v.getDate()));
export const dayDiff = (from: string | Date, to: string | Date) => Math.round((dateOnly(to).getTime() - dateOnly(from).getTime()) / DAY_MS);

/** Minutes between two ISO timestamps (wake after bed; never negative). */
export function durationMinutes(bedtime: string, wakeTime: string): number {
  const ms = new Date(wakeTime).getTime() - new Date(bedtime).getTime();
  return Math.max(0, Math.round(ms / 60_000));
}

/** Minutes since midnight of a local time; bedtimes before 04:00 count as 24h+ (after midnight). */
export function minutesOfDay(iso: string): number {
  const d = new Date(iso);
  const m = d.getHours() * 60 + d.getMinutes();
  return m < 240 ? m + 1440 : m;
}

/** "HH:MM" → minutes of day (same after-midnight rule). */
export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const v = (h || 0) * 60 + (m || 0);
  return v < 240 ? v + 1440 : v;
}

export const fmtHours = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;

/** Logs for one member within the last `days` nights, newest first. */
export function recentLogs<T extends SleepLogLike>(logs: T[], memberId: string, today: Date, days = 7): T[] {
  return logs
    .filter((l) => l.member_id === memberId && dayDiff(l.sleep_date, today) >= 0 && dayDiff(l.sleep_date, today) < days)
    .sort((a, b) => (a.sleep_date < b.sleep_date ? 1 : -1));
}

export function averageDuration(logs: SleepLogLike[]): number | null {
  if (!logs.length) return null;
  return Math.round(logs.reduce((a, l) => a + l.duration_min, 0) / logs.length);
}

/** Minutes short of the target minimum over the given logs (never negative per night). */
export function sleepDebtMinutes(logs: SleepLogLike[], targetMinHours: number): number {
  const target = targetMinHours * 60;
  return logs.reduce((a, l) => a + Math.max(0, target - l.duration_min), 0);
}

/** 0–100: how consistent bedtimes are (std dev of bedtime minutes; 0 min → 100, ≥ 90 min → 0). */
export function consistencyScore(logs: SleepLogLike[]): number | null {
  if (logs.length < 2) return null;
  const mins = logs.map((l) => minutesOfDay(l.bedtime));
  const mean = mins.reduce((a, b) => a + b, 0) / mins.length;
  const sd = Math.sqrt(mins.reduce((a, b) => a + (b - mean) ** 2, 0) / mins.length);
  return Math.max(0, Math.min(100, Math.round(100 - (sd / 90) * 100)));
}

/** Share of logged nights that started within 30 minutes of the routine's target bedtime. */
export function routineAdherence(routine: RoutineLike | null | undefined, logs: SleepLogLike[]): number | null {
  if (!routine || !logs.length) return null;
  const target = timeToMinutes(routine.target_bedtime);
  const applicable = logs.filter((l) => routine.days_of_week.includes(dateOnly(l.sleep_date).getDay()));
  if (!applicable.length) return null;
  const onTime = applicable.filter((l) => Math.abs(minutesOfDay(l.bedtime) - target) <= 30).length;
  return Math.round((onTime / applicable.length) * 100);
}

export type SleepTrend = 'improving' | 'slipping' | 'steady' | 'unknown';

/** Compare the last 3 nights with the 4 before them. */
export function sleepTrend(logs: SleepLogLike[]): SleepTrend {
  if (logs.length < 5) return 'unknown';
  const recent = averageDuration(logs.slice(0, 3)) ?? 0;
  const before = averageDuration(logs.slice(3, 7)) ?? 0;
  if (recent - before >= 20) return 'improving';
  if (before - recent >= 20) return 'slipping';
  return 'steady';
}

export type HabitCorrelation = { factor: string; withFactor: number | null; withoutFactor: number | null; deltaMinutes: number | null; nights: number };

/** Average sleep on nights with vs without a habit (screens in bed, late caffeine, exercise). */
export function habitCorrelations(logs: SleepLogLike[], checkins: CheckinLike[]): HabitCorrelation[] {
  const byDate = new Map(checkins.map((c) => [`${c.member_id}:${c.checkin_date}`, c]));
  const factors: { factor: string; key: keyof Pick<CheckinLike, 'screens_in_bed' | 'caffeine_after_2pm' | 'exercised'> }[] = [
    { factor: 'Screens in bed', key: 'screens_in_bed' },
    { factor: 'Caffeine after 2pm', key: 'caffeine_after_2pm' },
    { factor: 'Exercised that day', key: 'exercised' },
  ];
  return factors.map(({ factor, key }) => {
    const withF: number[] = []; const without: number[] = [];
    for (const l of logs) {
      const c = byDate.get(`${l.member_id}:${l.sleep_date}`);
      if (!c) continue;
      (c[key] ? withF : without).push(l.duration_min);
    }
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const a = avg(withF); const b = avg(without);
    return { factor, withFactor: a, withoutFactor: b, deltaMinutes: a !== null && b !== null ? a - b : null, nights: withF.length + without.length };
  });
}

export type SleepSummary<T extends SleepLogLike = SleepLogLike> = {
  nights: number;
  avgMinutes: number | null;
  target: { min: number; max: number; label: string };
  debtMinutes: number;
  consistency: number | null;
  adherence: number | null;
  trend: SleepTrend;
  lastNight: T | null;
  status: 'on_track' | 'short' | 'no_data';
  text: string;
};

export function sleepSummary<T extends SleepLogLike>(logs: T[], routine: RoutineLike | null | undefined, age: number | null, today: Date, memberId: string): SleepSummary<T> {
  const week = recentLogs(logs, memberId, today, 7);
  const target = recommendedSleepHours(age);
  const avgMinutes = averageDuration(week);
  const debtMinutes = sleepDebtMinutes(week, target.min);
  const status = avgMinutes === null ? 'no_data' : avgMinutes >= target.min * 60 ? 'on_track' : 'short';
  const lastNight = week[0] ?? null;
  const text = status === 'no_data'
    ? 'No nights logged this week'
    : status === 'on_track'
      ? `${fmtHours(avgMinutes!)} avg · on track for ${target.min}–${target.max}h`
      : `${fmtHours(avgMinutes!)} avg · ${fmtHours(debtMinutes)} short this week`;
  return { nights: week.length, avgMinutes, target, debtMinutes, consistency: consistencyScore(week), adherence: routineAdherence(routine, week), trend: sleepTrend(recentLogs(logs, memberId, today, 14)), lastNight, status, text };
}

export type ProgramStep = { day: number; title: string; detail: string };

/**
 * A 7-day behavioural program from the summary: move bedtime earlier in
 * 15-minute steps when short, protect the wind-down, fix the wake time, and
 * remove the habit that correlates worst. Deterministic; the AI adds voice.
 */
export function weeklyProgram(summary: SleepSummary, correlations: HabitCorrelation[], routine: RoutineLike | null | undefined): ProgramStep[] {
  const shortBy = summary.avgMinutes === null ? 0 : Math.max(0, summary.target.min * 60 - summary.avgMinutes);
  const shiftSteps = Math.min(3, Math.ceil(shortBy / 15));
  const worst = correlations.filter((c) => c.deltaMinutes !== null && c.nights >= 4).sort((a, b) => (a.deltaMinutes ?? 0) - (b.deltaMinutes ?? 0))[0];
  const wake = routine?.target_wake ?? '07:00';
  const steps: ProgramStep[] = [];
  steps.push({ day: 1, title: `Fix the wake time at ${wake}`, detail: 'Same wake time every day, weekends included — it anchors the whole cycle.' });
  steps.push({ day: 2, title: 'Protect a 30-minute wind-down', detail: routine ? `Start the “${routine.target_bedtime}” routine 30 minutes early: dim lights, no screens.` : 'Dim lights and put screens away 30 minutes before bed.' });
  if (worst && (worst.deltaMinutes ?? 0) < -15) steps.push({ day: 3, title: `Drop “${worst.factor.toLowerCase()}”`, detail: `Nights with it averaged ${fmtHours(Math.abs(worst.deltaMinutes ?? 0))} less sleep in your own logs.` });
  else steps.push({ day: 3, title: 'Log a 2-minute check-in', detail: 'Energy, mood, caffeine and screens — the coach needs a week of these to find your pattern.' });
  for (let i = 0; i < shiftSteps; i++) steps.push({ day: 4 + i, title: `Bedtime 15 minutes earlier (step ${i + 1}/${shiftSteps})`, detail: `Closing a ${fmtHours(shortBy)} nightly gap in small steps sticks better than one big jump.` });
  while (steps.length < 7) steps.push({ day: steps.length + 1, title: steps.length === 6 ? 'Review the week' : 'Hold the routine', detail: steps.length === 6 ? 'Compare this week’s average and consistency with last week; keep what worked.' : 'Same wake time, same wind-down. Consistency is the whole trick.' });
  return steps.slice(0, 7);
}
