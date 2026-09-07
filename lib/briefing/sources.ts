// Pure mappers from the rows a brief reads to the snapshot `buildBrief` takes.
//
// WHY: the brief is composed in two places — the API route a person opens and
// the morning delivery the cron sends — and each reads the same tables. The
// row → snapshot mapping (which doses are due today, how a time-of-day reads)
// used to live inline in the route, which meant the cron would either
// duplicate it or drift from it. It is here, pure, so both call one function
// and `tests/briefing-decisions.test.ts` can pin it without a database.
import type { ConciergeSnapshot } from '@/lib/concierge/digest';

/** The columns a medication schedule read selects, with the medication embedded. */
export type MedicationScheduleRow = {
  time_of_day: string | null;
  days_of_week: number[] | null;
  ends_on: string | null;
  medications: { name: string; member_id: string | null; is_active: boolean } | null;
};

/** `08:30` → `8:30 AM`; null stays null. */
export function formatTimeOfDay(t: string | null): string | null {
  if (!t) return null;
  const [h, m] = t.split(':');
  const hour = Number(h);
  if (!Number.isFinite(hour)) return null;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${m ?? '00'} ${ampm}`;
}

/**
 * The doses due on the family's day: active medications whose schedule names
 * that weekday and has not ended. `todayDow` is the family-local weekday
 * (0 = Sunday, matching `medication_schedules.days_of_week`) and `today` the
 * family-local `YYYY-MM-DD`, both resolved by the caller in the family's zone.
 */
export function medicationsDueOn(
  rows: MedicationScheduleRow[],
  opts: { today: string; todayDow: number; memberName?: (memberId: string) => string | null | undefined },
): NonNullable<ConciergeSnapshot['medications']> {
  return (rows ?? [])
    .filter((s) => s.medications?.is_active !== false
      && (s.days_of_week ?? [0, 1, 2, 3, 4, 5, 6]).includes(opts.todayDow)
      && (!s.ends_on || s.ends_on >= opts.today))
    .map((s) => ({
      name: s.medications?.name ?? 'Medication',
      member: s.medications?.member_id ? opts.memberName?.(s.medications.member_id) ?? null : null,
      timeOfDay: formatTimeOfDay(s.time_of_day),
    }));
}

/** The family-local weekday for a `YYYY-MM-DD` key, 0 = Sunday. */
export function weekdayOf(dayKey: string): number {
  return new Date(`${dayKey}T12:00:00Z`).getUTCDay();
}
