// lib/notifications/medication-reminders.ts — pure builder that turns a
// family's active medications + dosing schedules + today's logged doses into
// "dose due today" reminders for the notification engine. Reuses the tested
// dosesForDay expansion so schedule math isn't duplicated.

import { dosesForDay, localDateKey, shortTime, type ScheduleLike, type DoseStatus } from '@/lib/medications/adherence';
import { zonedDayBoundsMs } from '@/lib/services/scope';

export interface MedLite {
  id: string;
  name: string;
  dosage: string | null;
  member_id: string | null;
  is_active: boolean;
}
export interface DoseLogLite {
  schedule_id: string | null;
  scheduled_for: string;
  status: DoseStatus;
}

export interface MedReminder {
  type: 'medication_due';
  related_type: 'medications';
  /**
   * `<medication id>:<dose day>` — the family's day this reminder is about, so a
   * day's reminder is ONE occurrence (the engine's permanent dedupe, and 0489's
   * index behind it, hold it to one row) and tomorrow's is the next. Before
   * this the key was the bare medication id, and the engine kept a separate
   * same-day read for medications alone; a key that names the day lets them
   * dedupe like every other candidate.
   */
  related_id: string;
  user_id: string | null;
  title: string;
  body: string;
  /**
   * The bare medication id these rows carried before the key named the day,
   * and the instant this day began in the family's zone: a row under the old
   * key from this day counts as today's reminder, already sent, so the first
   * run with the dated key does not remind the family twice (see
   * Candidate.legacy in lib/server/notifications.ts).
   */
  legacy: { related_id: string; since: string };
}

/**
 * One reminder per active medication that still has at least one *pending*
 * (not taken/skipped) dose scheduled for `now`'s local day. Member-specific
 * meds notify that member once their account is resolved; otherwise they wait
 * for a later scan. Whole-family meds fan out to every manager (or a single
 * family-wide row when there are none).
 *
 * `now` must already read as the family's wall clock (`asWallClockIn`) and
 * `timezone` must be the family's zone, or the day, the weekday and the instant
 * each logged dose is matched against are the runtime's — UTC on the cron — and
 * a household outside UTC is reminded about doses it has already taken.
 */
export function medicationDueReminders(
  meds: MedLite[],
  schedules: ScheduleLike[],
  doses: DoseLogLite[],
  userByMember: Map<string, string | null>,
  managers: { user_id: string | null }[],
  now: Date,
  timezone?: string | null,
): MedReminder[] {
  const schedulesByMed = new Map<string, ScheduleLike[]>();
  for (const s of schedules) {
    const arr = schedulesByMed.get(s.medication_id) ?? [];
    arr.push(s);
    schedulesByMed.set(s.medication_id, arr);
  }

  // The day `dosesForDay` reads the schedules against, as it reads it, and the
  // instant that day began where the family lives.
  const dayKey = localDateKey(now);
  const dayStartIso = new Date(zonedDayBoundsMs(dayKey, timezone || 'UTC').start).toISOString();

  const out: MedReminder[] = [];
  for (const med of meds) {
    if (!med.is_active) continue;
    const medSchedules = schedulesByMed.get(med.id) ?? [];
    if (medSchedules.length === 0) continue;

    const due = dosesForDay(medSchedules, doses, now, timezone);
    const pending = due.filter((d) => d.status === 'pending');
    if (pending.length === 0) continue;

    const nextTime = pending[0].time; // dosesForDay returns time-sorted slots
    const count = pending.length;
    const title = `Medication due: ${med.name}`;
    const body = `${med.dosage ? `${med.dosage} · ` : ''}${count} dose${count > 1 ? 's' : ''} today — next at ${shortTime(nextTime)}`;

    const base = {
      type: 'medication_due' as const, related_type: 'medications' as const,
      related_id: `${med.id}:${dayKey}`, title, body,
      legacy: { related_id: med.id, since: dayStartIso },
    };

    if (med.member_id) {
      const userId = userByMember.get(med.member_id);
      // A missing private recipient is not a family-wide audience. This also
      // defers the reminder when the generator could not read the roster.
      if (!userId) continue;
      out.push({ ...base, user_id: userId });
    } else if (managers.length === 0) {
      out.push({ ...base, user_id: null });
    } else {
      for (const m of managers) out.push({ ...base, user_id: m.user_id });
    }
  }
  return out;
}
