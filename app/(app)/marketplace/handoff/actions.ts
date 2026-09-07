'use server';

// Pickup & hand-off server actions. One side proposes a time + safe meetup
// spot; the OTHER side confirms (which drops it on the family calendar and mints
// a short hand-off code); the exchange is completed in person by entering that
// code, which also advances the order to 'completed'. Family-scoped via
// requireUserContext + RLS on marketplace_handoffs.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { generateHandoffCode, type LocationKind } from '@/lib/marketplace/handoff';
import { describeActionError } from '@/lib/supabase/errors';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

function actionFailure<T = undefined>(operation: string, message: string, error: unknown): Result<T> {
  console.error(`[marketplace-handoff] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

const COMPLETE_REASON: Record<string, string> = {
  unauthenticated: 'Please sign in to complete the pickup.',
  invalid_request: 'Enter a valid hand-off code.',
  order_not_found: 'actions.orderNotFound',
  forbidden: 'You are not part of this marketplace exchange.',
  order_not_open: 'This order is already closed.',
  handoff_not_found: 'This pickup could not be found.',
  handoff_not_ready: 'This pickup is not ready to complete.',
  code_mismatch: 'That code doesn’t match. Check with the other person.',
};

async function loadOrderRole(orderId: string) {
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { data: order, error: orderError } = await sb
    .from('marketplace_orders')
    .select('id, family_id, listing_id, buyer_member, seller_member, status')
    .eq('id', orderId).eq('family_id', ctx.active.familyId).maybeSingle();
  return { ctx, sb, order, orderError };
}

/** Propose (or re-propose) a pickup. Upserts the single handoff for the order. */
export async function proposeHandoffAction(input: {
  orderId: string; meetAtIso?: string | null; locationLabel: string; locationKind?: LocationKind; notes?: string;
}): Promise<Result> {
  const t = await getTranslations();
  const { ctx, sb, order, orderError } = await loadOrderRole(input.orderId);
  if (orderError) return actionFailure('load the order', t('marketplace.couldNotLoadTheOrder'), orderError);
  if (!order) return { ok: false, error: t('actions.orderNotFound') };
  if (['completed', 'cancelled'].includes(order.status)) return { ok: false, error: t('actions.thisOrderIsClosed') };
  if (!input.locationLabel?.trim()) return { ok: false, error: t('actions.pickOrTypeAMeetup') };

  const role = order.seller_member === ctx.active.member.id ? 'seller' : 'buyer';
  const { error } = await sb.from('marketplace_handoffs').upsert({
    order_id: order.id, family_id: order.family_id, listing_id: order.listing_id,
    proposed_by: ctx.active.member.id, proposer_role: role,
    meet_at: input.meetAtIso ?? null, location_label: input.locationLabel.trim(),
    location_kind: input.locationKind ?? 'public_spot', status: 'proposed',
    confirm_code: null, confirmed_at: null, completed_at: null, calendar_event_id: null,
    notes: input.notes?.trim() || null,
  }, { onConflict: 'order_id' });
  if (error) return actionFailure('propose the pickup', t('handoff.couldNotProposeThePickup'), error);

  revalidatePath('/marketplace/orders');
  return { ok: true };
}

/** The other party confirms the proposal → calendar event + hand-off code. */
export async function confirmHandoffAction(orderId: string): Promise<Result<{ code: string }>> {
  const t = await getTranslations();
  const { ctx, sb, order, orderError } = await loadOrderRole(orderId);
  if (orderError) return actionFailure('load the order', t('marketplace.couldNotLoadTheOrder'), orderError);
  if (!order) return { ok: false, error: t('actions.orderNotFound') };

  const { data: handoff, error: handoffError } = await sb.from('marketplace_handoffs')
    .select('id, proposer_role, status, meet_at, location_label').eq('order_id', orderId).maybeSingle();
  if (handoffError) return actionFailure('load the pickup', t('handoff.couldNotLoadThePickup'), handoffError);
  if (!handoff) return { ok: false, error: t('actions.noPickupToConfirm') };
  if (handoff.status !== 'proposed') return { ok: false, error: t('actions.thisPickupCanTBe') };
  const role = order.seller_member === ctx.active.member.id ? 'seller' : 'buyer';
  if (role === handoff.proposer_role) return { ok: false, error: t('actions.waitForTheOtherPerson') };

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
  if (error) return actionFailure('confirm the pickup', t('handoff.couldNotConfirmThePickup'), error);

  revalidatePath('/marketplace/orders');
  return { ok: true, data: { code } };
}

/** Cancel a proposed/confirmed pickup (either party). */
export async function cancelHandoffAction(orderId: string): Promise<Result> {
  const t = await getTranslations();
  const { sb, order, orderError } = await loadOrderRole(orderId);
  if (orderError) return actionFailure('load the order', t('marketplace.couldNotLoadTheOrder'), orderError);
  if (!order) return { ok: false, error: t('actions.orderNotFound') };
  const { error } = await sb.from('marketplace_handoffs').update({ status: 'cancelled' })
    .eq('order_id', orderId).in('status', ['proposed', 'confirmed']);
  if (error) return actionFailure('cancel the pickup', t('handoff.couldNotCancelThePickup'), error);
  revalidatePath('/marketplace/orders');
  return { ok: true };
}

/** Complete the hand-off in person by entering the code → order completed. */
export async function completeHandoffAction(input: { orderId: string; code: string }): Promise<Result> {
  const t = await getTranslations();
  await requireUserContext();
  const sb = await createServer();
  const { data, error } = await sb.rpc('marketplace_complete_handoff', {
    p_order_id: input.orderId,
    p_code: input.code,
  });
  if (error) return actionFailure('complete the pickup', t('actions.couldNotCompleteThePickup'), error);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return actionFailure('complete the pickup', t('actions.couldNotCompleteThePickup'), new Error('Invalid hand-off completion response'));
  }
  const result = data as { ok?: unknown; reason?: unknown };
  if (result.ok !== true) {
    return { ok: false, error: t(COMPLETE_REASON[String(result.reason)] ?? 'actions.couldNotCompleteThePickup') };
  }

  revalidatePath('/marketplace/orders');
  return { ok: true };
}
