// lib/trips/follow-event.ts — a Smart Departure follows the event it was planned for.
//
// `departure_plans.event_start` is a COPY of the event's start, taken when the
// plan was saved, and the plan writes a "🚗 Head out" calendar event at the
// leave-by it computes from that copy. Moving the event (the calendar editor,
// a conflict quick fix, the assistant) changed only `calendar_events`, so the
// game moved from Saturday 10:00 to Sunday 14:00 and the head-out reminder
// stayed on Saturday morning — pushed by the notifications run, and written
// back at the old time by every Refresh.
//
// So whoever moves an event calls this with the start it had and the start it
// has now. Each plan for the event moves by the same amount (a series moved an
// hour moves each week's plan an hour), its leave-by is recomputed from the
// numbers it already holds, and its head-out event moves with it. A refused
// reminder move leaves that plan as it was, so the plan and its reminder never
// disagree, and Refresh — which now reads the event's own start
// (app/(app)/dashboard/trip-intel/actions.ts) — is the way back.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { compareExactInstants } from '@/lib/calendar/exact-instant';
import { departureFromEstimate } from '@/lib/trips/drive-time';
import { wroteNoRows } from '@/lib/supabase/errors';
import { getFormat } from '@/lib/utils/format-server';

type Db = SupabaseClient<Database>;

export type FollowMovedEventInput = {
  familyId: string;
  eventId: string;
  /** The event's start before the move, as stored. */
  previousStartsAt: string;
  /** The event's start after the move, as stored. */
  startsAt: string;
  /** The family's zone, for the leave-by clock written into the reminder. */
  tz: string;
  now?: Date;
};

/** `moved` plans now match the event; `ok: false` means at least one could not be moved (logged). */
export async function followMovedEvent(db: Db, input: FollowMovedEventInput): Promise<{ ok: boolean; moved: number }> {
  let same: boolean;
  try { same = compareExactInstants(input.previousStartsAt, input.startsAt) === 0; } catch { return { ok: false, moved: 0 }; }
  if (same) return { ok: true, moved: 0 };
  const shift = Date.parse(input.startsAt) - Date.parse(input.previousStartsAt);
  if (!Number.isFinite(shift)) return { ok: false, moved: 0 };

  const { data: plans, error } = await db.from('departure_plans')
    .select('id, event_start, prep_minutes, park_minutes, buffer_minutes, drive_seconds, traffic_factor, weather_delay_minutes, destination, reminder_event_id')
    .eq('family_id', input.familyId).eq('event_id', input.eventId);
  if (error) {
    console.error('[trip-intel] departure plans for a moved event could not be read', { eventId: input.eventId, error });
    return { ok: false, moved: 0 };
  }
  if (!plans?.length) return { ok: true, moved: 0 };

  const { fmtDate } = await getFormat(input.tz);
  const now = input.now ?? new Date();
  let moved = 0;
  let ok = true;
  for (const plan of plans) {
    const planned = Date.parse(plan.event_start);
    if (!Number.isFinite(planned)) { ok = false; continue; }
    const eventStart = new Date(planned + shift).toISOString();
    const departure = departureFromEstimate({
      driveSeconds: plan.drive_seconds, prepMinutes: plan.prep_minutes, parkMinutes: plan.park_minutes,
      trafficFactor: plan.traffic_factor, weatherDelayMinutes: plan.weather_delay_minutes,
      bufferMinutes: plan.buffer_minutes, source: 'manual',
    }, eventStart, now);

    if (plan.reminder_event_id) {
      const { data: reminder, error: reminderError } = await db.from('calendar_events')
        .update({
          starts_at: departure.leaveByISO,
          ends_at: new Date(Date.parse(departure.leaveByISO) + 5 * 60_000).toISOString(),
          description: `Updated: leave by ${fmtDate(departure.leaveByISO, 'h:mm a')} to reach ${plan.destination ?? 'your destination'} on time.`,
        })
        .eq('id', plan.reminder_event_id).eq('family_id', input.familyId).select('id');
      // A refused move keeps the plan where its reminder still is. A reminder
      // the family deleted from the calendar is not one to move: its link
      // clears on delete, and the next Refresh writes a fresh one.
      if (reminderError) {
        console.error('[trip-intel] head-out reminder for a moved event could not be moved', { planId: plan.id, error: reminderError });
        ok = false;
        continue;
      }
      if (wroteNoRows(reminder)) console.warn('[trip-intel] head-out reminder for a moved event is gone', { planId: plan.id });
    }

    const { data: saved, error: planError } = await db.from('departure_plans')
      .update({ event_start: eventStart, leave_by: departure.leaveByISO })
      .eq('id', plan.id).eq('family_id', input.familyId).select('id');
    if (planError || wroteNoRows(saved)) {
      console.error('[trip-intel] departure plan for a moved event could not be moved', { planId: plan.id, error: planError ?? 'no rows updated' });
      ok = false;
      continue;
    }
    moved += 1;
  }
  return { ok, moved };
}
