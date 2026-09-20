// lib/notifications/medication-reminders.ts — pure builder that turns a
// family's active medications + dosing schedules + today's logged doses into
// "dose due today" reminders for the notification engine. Reuses the tested
// dosesForDay expansion so schedule math isn't duplicated.

import { dosesForDay, shortTime, type ScheduleLike, type DoseStatus } from '@/lib/medications/adherence';

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
  related_id: string;   // medication id (a real uuid) — same-day deduped by the engine
  user_id: string | null;
  title: string;
  body: string;
}

/**
 * One reminder per active medication that still has at least one *pending*
 * (not taken/skipped) dose scheduled for `now`'s local day. Member-specific
 * meds notify that member; whole-family meds fan out to every manager (or a
 * single family-wide row when there are none).
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

    const base = { type: 'medication_due' as const, related_type: 'medications' as const, related_id: med.id, title, body };

    if (med.member_id) {
      out.push({ ...base, user_id: userByMember.get(med.member_id) ?? null });
    } else if (managers.length === 0) {
      out.push({ ...base, user_id: null });
    } else {
      for (const m of managers) out.push({ ...base, user_id: m.user_id });
    }
  }
  return out;
}
