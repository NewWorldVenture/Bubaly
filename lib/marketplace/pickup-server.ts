// Taking a marketplace pickup down: the pickup row and its family-calendar
// event go together. Shared by the hand-off actions (cancel, confirm) and the
// order lifecycle (cancelling an order), which act on the caller's own session.
import 'server-only';
import type { createServer } from '@/lib/supabase/server';
import { wroteNoRows } from '@/lib/supabase/errors';

type Db = Awaited<ReturnType<typeof createServer>>;

/**
 * Take a pickup's event off the family calendar. A pickup that is off must not
 * stay there: the daily notifications run (lib/server/notifications.ts) turns
 * every event in the next 48 hours into a reminder for the family, and a pickup
 * arranged again lands beside it at its new time.
 *
 * The pickup's own state is the answer the person gets, so a failure here is
 * logged rather than returned: the calendar is the family's copy of it, and the
 * event can still be deleted there.
 */
export async function removePickupFromCalendar(sb: Db, familyId: string, eventId: string | null | undefined): Promise<void> {
  if (!eventId) return;
  const { data: removed, error } = await sb.from('calendar_events').delete()
    .eq('id', eventId).eq('family_id', familyId).select('id');
  if (error || wroteNoRows(removed)) {
    console.error('[marketplace-handoff] the pickup stayed on the family calendar', error ?? { eventId });
  }
}

/**
 * Cancel an order's open pickup, proposed or confirmed, and take it off the
 * calendar: the order it was arranged for is off. No open pickup is the
 * ordinary case and does nothing.
 *
 * Called after the order's own cancel landed, which is the answer the person
 * gets; a pickup that cannot be cancelled is logged, not returned.
 */
export async function cancelOrderPickup(sb: Db, orderId: string, familyId: string): Promise<void> {
  const { data: cancelled, error } = await sb.from('marketplace_handoffs').update({ status: 'cancelled' })
    .eq('order_id', orderId).eq('family_id', familyId).in('status', ['proposed', 'confirmed'])
    .select('id, calendar_event_id');
  if (error) {
    console.error('[marketplace-handoff] the cancelled order kept its pickup', error);
    return;
  }
  for (const row of cancelled ?? []) await removePickupFromCalendar(sb, familyId, row.calendar_event_id);
}
