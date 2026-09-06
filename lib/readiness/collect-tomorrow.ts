import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { dayKeyInTz, zonedDayBoundsMs } from '@/lib/services/scope';
import type { ReadinessCoverage, ReadinessSignals } from './assess';
import { calendarReadiness } from './calendar-source';

export type TomorrowReadiness = Pick<
  ReadinessSignals,
  'tomorrowConflicts' | 'tomorrowUnassigned' | 'dinnerPlannedTomorrow'
> & {
  tomorrowCalendarCoverage: ReadinessCoverage;
  coverage: { meals_tomorrow: ReadinessCoverage };
};

/**
 * Collect tomorrow's evidence with the caller's existing access, not a
 * privileged client. The assessor remains responsible for readiness rules.
 */
export async function collectTomorrowReadiness(
  db: SupabaseClient<Database>,
  familyId: string,
  timezone: string | null | undefined,
  now: Date = new Date(),
): Promise<TomorrowReadiness> {
  let tz: string;
  try {
    tz = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/New_York',
    }).resolvedOptions().timeZone;
  } catch {
    tz = 'UTC';
  }

  // Advance the local calendar label, not the current instant by 24 hours.
  // Resolving the resulting date's two midnights preserves 23/25-hour days.
  const nextDate = new Date(`${dayKeyInTz(now, tz)}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const tomorrowKey = nextDate.toISOString().slice(0, 10);
  const bounds = zonedDayBoundsMs(tomorrowKey, tz);

  const [events, dinner] = await Promise.all([
    Promise.resolve(
      db.from('calendar_events')
        .select('id, starts_at, ends_at, all_day, assignee_id', { count: 'exact' })
        .eq('family_id', familyId)
        .gte('starts_at', new Date(bounds.start).toISOString())
        .lt('starts_at', new Date(bounds.end).toISOString())
        .order('starts_at'),
    ).catch(() => ({ data: null, count: null, error: true })),
    Promise.resolve(
      db.from('meal_plans')
        .select('plan_date', { count: 'exact', head: true })
        .eq('family_id', familyId)
        .eq('plan_date', tomorrowKey)
        .eq('meal_type', 'dinner'),
    ).catch(() => ({ data: null, count: null, error: true })),
  ]);

  const calendar = calendarReadiness(events);
  const dinnerKnown = !dinner.error && typeof dinner.count === 'number'
    && Number.isSafeInteger(dinner.count) && dinner.count >= 0;
  return {
    tomorrowConflicts: calendar.conflicts,
    tomorrowUnassigned: calendar.unassigned,
    dinnerPlannedTomorrow: dinnerKnown && (dinner.count ?? 0) > 0,
    tomorrowCalendarCoverage: calendar.calendarCoverage,
    coverage: { meals_tomorrow: dinnerKnown ? 'complete' : 'unknown' },
  };
}
