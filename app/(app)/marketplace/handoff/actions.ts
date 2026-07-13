'use server';

// Pickup & hand-off server actions. One side proposes a time + safe meetup
// spot; the OTHER side confirms (which drops it on the family calendar and mints
// a short hand-off code); the exchange is completed in person by entering that
// code, which also advances the order to 'completed'. Family-scoped via
// requireUserContext + RLS on marketplace_handoffs.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { generateHandoffCode, codesMatch, type LocationKind } from '@/lib/marketplace/handoff';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

async function loadOrderRole(orderId: string) {
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { data: order } = await sb
    .from('marketplace_orders')
    .select('id, family_id, listing_id, buyer_member, seller_member, status')
    .eq('id', orderId).eq('family_id', ctx.active.familyId).maybeSingle();
  return { ctx, sb, order };
}

/** Propose (or re-propose) a pickup. Upserts the single handoff for the order. */
export async function proposeHandoffAction(input: {
  orderId: string; meetAtIso?: string | null; locationLabel: string; locationKind?: LocationKind; notes?: string;
}): Promise<Result> {
  const { ctx, sb, order } = await loadOrderRole(input.orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (['completed', 'cancelled'].includes(order.status)) return { ok: false, error: 'This order is closed.' };
  if (!input.locationLabel?.trim()) return { ok: false, error: 'Pick or type a meetup spot.' };

  const role = order.seller_member === ctx.active.member.id ? 'seller' : 'buyer';
  const { error } = await sb.from('marketplace_handoffs').upsert({
    order_id: order.id, family_id: order.family_id, listing_id: order.listing_id,
    proposed_by: ctx.active.member.id, proposer_role: role,
    meet_at: input.meetAtIso ?? null, location_label: input.locationLabel.trim(),
    location_kind: input.locationKind ?? 'public_spot', status: 'proposed',
    confirm_code: null, confirmed_at: null, completed_at: null, calendar_event_id: null,
    notes: input.notes?.trim() || null,
  }, { onConflict: 'order_id' });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/marketplace/orders');
  return { ok: true };
}

/** The other party confirms the proposal → calendar event + hand-off code. */
export async function confirmHandoffAction(orderId: string): Promise<Result<{ code: string }>> {
  const { ctx, sb, order } = await loadOrderRole(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };

  const { data: handoff } = await sb.from('marketplace_handoffs')
    .select('id, proposer_role, status, meet_at, location_label').eq('order_id', orderId).maybeSingle();
  if (!handoff) return { ok: false, error: 'No pickup to confirm.' };
  if (handoff.status !== 'proposed') return { ok: false, error: 'This pickup can’t be confirmed anymore.' };
  const role = order.seller_member === ctx.active.member.id ? 'seller' : 'buyer';
  if (role === handoff.proposer_role) return { ok: false, error: 'Wait for the other person to confirm your proposal.' };

  const code = generateHandoffCode();

  // Best-effort: put the pickup on the family calendar.
  let calendarEventId: string | null = null;
  if (handoff.meet_at) {
    try {
      const { data: ev } = await sb.from('calendar_events').insert({
        family_id: order.family_id,
        title: `Marketplace pickup${handoff.location_label ? ` · ${handoff.location_label}` : ''}`,
        description: 'Bubaly marketplace hand-off. Bring the item + the hand-off code.',
        location: handoff.location_label, category: 'general',
        starts_at: handoff.meet_at, created_by: ctx.user.id,
      }).select('id').single();
      calendarEventId = ev?.id ?? null;
    } catch { /* calendar optional — confirmation still succeeds */ }
  }

  const { error } = await sb.from('marketplace_handoffs').update({
    status: 'confirmed', confirmed_at: new Date().toISOString(), confirm_code: code,
    calendar_event_id: calendarEventId,
  }).eq('order_id', orderId).eq('status', 'proposed');
  if (error) return { ok: false, error: error.message };

  revalidatePath('/marketplace/orders');
  return { ok: true, data: { code } };
}

/** Cancel a proposed/confirmed pickup (either party). */
export async function cancelHandoffAction(orderId: string): Promise<Result> {
  const { sb, order } = await loadOrderRole(orderId);
  if (!order) return { ok: false, error: 'Order not found.' };
  const { error } = await sb.from('marketplace_handoffs').update({ status: 'cancelled' })
    .eq('order_id', orderId).in('status', ['proposed', 'confirmed']);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/marketplace/orders');
  return { ok: true };
}

/** Complete the hand-off in person by entering the code → order completed. */
export async function completeHandoffAction(input: { orderId: string; code: string }): Promise<Result> {
  const { sb, order } = await loadOrderRole(input.orderId);
  if (!order) return { ok: false, error: 'Order not found.' };

  const { data: handoff } = await sb.from('marketplace_handoffs')
    .select('confirm_code, status').eq('order_id', input.orderId).maybeSingle();
  if (!handoff || handoff.status !== 'confirmed') return { ok: false, error: 'This pickup isn’t ready to complete.' };
  if (!codesMatch(input.code, handoff.confirm_code)) return { ok: false, error: 'That code doesn’t match. Check with the other person.' };

  const now = new Date().toISOString();
  const { error } = await sb.from('marketplace_handoffs').update({ status: 'completed', completed_at: now })
    .eq('order_id', input.orderId).eq('status', 'confirmed');
  if (error) return { ok: false, error: error.message };

  // Advance the order to completed (best-effort; RLS-scoped to the family).
  await sb.from('marketplace_orders').update({ status: 'completed' })
    .eq('id', input.orderId).in('status', ['confirmed', 'active', 'returned']);

  revalidatePath('/marketplace/orders');
  return { ok: true };
}
