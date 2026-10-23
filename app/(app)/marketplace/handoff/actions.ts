'use server';

// Pickup & hand-off server actions. One side proposes a time + safe meetup
// spot; the OTHER side confirms (which drops it on the family calendar and mints
// a short hand-off code that only the confirmer holds); the exchange is
// completed in person by the PROPOSER entering that code, which also advances
// the order: to 'completed' for a sale, to 'active' for a rent or a borrow,
// whose loan starts at the pickup. Family-scoped via requireUserContext + RLS
// on marketplace_handoffs.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import {
  codesMatch, generateHandoffCode, holdsHandoffCode, isLoanKind, type HandoffRole, type LocationKind,
} from '@/lib/marketplace/handoff';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { readFamilyOrders } from '@/lib/marketplace/schema-compat';
import { removePickupFromCalendar } from '@/lib/marketplace/pickup-server';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

function actionFailure<T = undefined>(operation: string, message: string, error: unknown): Result<T> {
  console.error(`[marketplace-handoff] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

/**
 * Refusal reasons → catalogue KEYS. Every value here is passed to `t()`.
 *
 * Eight of these were English sentences, and `translate()` falls back to the
 * key when it resolves nothing — so a sentence passed as a key renders as
 * itself. It looked correct in en-US and was untranslated in the other ten
 * locales, which is the failure mode that hides: a key that renders as readable
 * English is far harder to notice than one that renders as
 * `siteFooter.acceptableUse`. Nine refusal messages on a money-adjacent flow,
 * in English, inside an otherwise fully localised screen. Audit C1-S4-03.
 */
const COMPLETE_REASON: Record<string, string> = {
  unauthenticated: 'actions.pleaseSignInToComplete',
  invalid_request: 'actions.enterAValidHandOff',
  order_not_found: 'actions.orderNotFound',
  forbidden: 'actions.youAreNotPartOf',
  order_not_open: 'actions.thisOrderIsAlreadyClosed',
  handoff_not_found: 'actions.thisPickupCouldNotBe',
  handoff_not_ready: 'actions.thisPickupIsNotReady',
  code_mismatch: 'actions.thatCodeDoesnTMatch',
};

async function loadOrderRole(orderId: string) {
  const ctx = await requireUserContext();
  const sb = await createServer();
  // Either side's family: an order from an auction, Buy-It-Now or an accepted
  // negotiation carries the SELLER's family_id, and the winner's household is
  // buyer_family_id (proposed economy SQL, section 2). Without that column the
  // read is the seller-family read it always was (readFamilyOrders).
  const { data: order, error: orderError } = await readFamilyOrders(ctx.active.familyId, (scope) => scope(sb
    .from('marketplace_orders')
    .select('id, family_id, listing_id, buyer_member, seller_member, kind, status')
    .eq('id', orderId)).maybeSingle());
  // Only the two people in the exchange arrange its pickup. Anyone else in the
  // family used to be treated as the buyer here (`seller ? 'seller' : 'buyer'`),
  // so a sibling could propose, confirm - minting the hand-off code - or cancel
  // someone else's pickup. 0372 enforces the same in RLS; `null` means not a
  // party, and returning it from the loader means no call site can forget the
  // check. Audit C3-S4-02.
  const role: 'seller' | 'buyer' | null =
    order?.seller_member === ctx.active.member.id ? 'seller'
      : order?.buyer_member === ctx.active.member.id ? 'buyer'
        : null;
  return { ctx, sb, order, orderError, role };
}

/**
 * A child or teen does not arrange to meet another household's adult. Within
 * the family the two parties are siblings and parents, and nothing changes;
 * across families (an item won at auction or bought from a circle) only a
 * parent or adult proposes or confirms the meeting. The counterpart is
 * outside the family when no active member of the caller's family carries
 * that id. A failed read refuses rather than guessing "same family".
 */
async function minorMeetingOutsider(
  { ctx, sb, order, role }: Awaited<ReturnType<typeof loadOrderRole>>,
): Promise<boolean> {
  if (isManager(ctx.active.role) || !order || !role) return false;
  const other = role === 'seller' ? order.buyer_member : order.seller_member;
  if (!other) return true;
  const { data, error } = await sb.from('family_members').select('id')
    .eq('id', other).eq('family_id', ctx.active.familyId).maybeSingle();
  return Boolean(error) || !data;
}

/** Propose (or re-propose) a pickup: the order's single handoff, first or again. */
export async function proposeHandoffAction(input: {
  orderId: string; meetAtIso?: string | null; locationLabel: string; locationKind?: LocationKind; notes?: string;
}): Promise<Result> {
  const t = await getTranslations();
  const loaded = await loadOrderRole(input.orderId);
  const { ctx, sb, order, orderError, role } = loaded;
  if (orderError) return actionFailure('load the order', t('marketplace.couldNotLoadTheOrder'), orderError);
  if (!order) return { ok: false, error: t('actions.orderNotFound') };
  if (!role) return { ok: false, error: t(COMPLETE_REASON.forbidden) };
  if (await minorMeetingOutsider(loaded)) return { ok: false, error: t('actions.onlyAParentGuardianCan16') };
  if (['completed', 'cancelled'].includes(order.status)) return { ok: false, error: t('actions.thisOrderIsClosed') };
  if (!input.locationLabel?.trim()) return { ok: false, error: t('actions.pickOrTypeAMeetup') };

  // This was an upsert on `order_id` that never looked at what it replaced.
  // Reschedule is offered while a pickup is proposed, so pressed on a screen
  // that had not caught up with the other party confirming it, it put the
  // pickup back to `proposed`, cleared the code they were holding and unlinked
  // its calendar event. Read it, and rewrite only what may be rewritten.
  const { data: current, error: currentError } = await sb.from('marketplace_handoffs')
    .select('id, status, calendar_event_id').eq('order_id', order.id).eq('family_id', order.family_id).maybeSingle();
  if (currentError) return actionFailure('load the pickup', t('handoff.couldNotLoadThePickup'), currentError);
  if (current && current.status !== 'proposed' && current.status !== 'cancelled') {
    return { ok: false, error: t('handoff.pickupChangedRefresh') };
  }

  const proposal = {
    proposed_by: ctx.active.member.id, proposer_role: role,
    meet_at: input.meetAtIso ?? null, location_label: input.locationLabel.trim(),
    location_kind: input.locationKind ?? 'public_spot', status: 'proposed',
    confirm_code: null, confirmed_at: null, completed_at: null, calendar_event_id: null,
    notes: input.notes?.trim() || null,
  };
  if (!current) {
    // `order_id` is unique, so a first pickup the other party arranged a moment
    // earlier makes this a 23505 rather than a second row or an overwrite.
    const { error } = await sb.from('marketplace_handoffs').insert({
      order_id: order.id, family_id: order.family_id, listing_id: order.listing_id, ...proposal,
    });
    if (error?.code === '23505') return { ok: false, error: t('handoff.pickupChangedRefresh') };
    if (error) return actionFailure('propose the pickup', t('handoff.couldNotProposeThePickup'), error);
  } else {
    // Guarded on the status it was read in: one confirmed in between matches nothing.
    const { data: proposed, error } = await sb.from('marketplace_handoffs').update(proposal)
      .eq('id', current.id).eq('family_id', order.family_id).eq('status', current.status).select('id');
    if (error) return actionFailure('propose the pickup', t('handoff.couldNotProposeThePickup'), error);
    if (wroteNoRows(proposed)) return { ok: false, error: t('handoff.pickupChangedRefresh') };
    // A pickup cancelled before cancelling took its event down can still link
    // one; arranged again, that is the old time left on the calendar.
    if (current.status === 'cancelled') await removePickupFromCalendar(sb, ctx.active.familyId, current.calendar_event_id);
  }

  revalidatePath('/marketplace/orders');
  return { ok: true };
}

/** The proposal a confirmer's screen showed: the time and place they agreed to. */
export type SeenProposal = { meetAt: string | null; locationLabel: string | null };

/** The same meeting: one instant (however the timestamp is spelled) and one place. */
function sameProposal(row: { meet_at: string | null; location_label: string | null }, seen: SeenProposal): boolean {
  const at = (iso: string | null) => (iso === null ? null : Date.parse(iso));
  return at(row.meet_at) === at(seen.meetAt) && (row.location_label ?? null) === (seen.locationLabel ?? null);
}

/**
 * The other party confirms the proposal → calendar event + hand-off code.
 *
 * `seen` is the proposal the confirmer's screen showed. A reschedule rewrites
 * meet_at and location_label and leaves the pickup 'proposed', so the status
 * alone cannot tell the proposal they read from the one stored now: pressed
 * after the proposer moved it, Confirm agreed to a time and place the
 * confirmer never saw. What was seen is checked against the row, and the claim
 * is predicated on the time and place this read returned, so the calendar
 * event and the confirmed row always describe the same meeting.
 */
export async function confirmHandoffAction(orderId: string, seen?: SeenProposal): Promise<Result<{ code: string }>> {
  const t = await getTranslations();
  const loaded = await loadOrderRole(orderId);
  const { ctx, sb, order, orderError, role } = loaded;
  if (orderError) return actionFailure('load the order', t('marketplace.couldNotLoadTheOrder'), orderError);
  if (!order) return { ok: false, error: t('actions.orderNotFound') };
  // This action MINTS AND RETURNS the hand-off code, so it is the one a
  // non-party most wanted to reach.
  if (!role) return { ok: false, error: t(COMPLETE_REASON.forbidden) };
  if (await minorMeetingOutsider(loaded)) return { ok: false, error: t('actions.onlyAParentGuardianCan16') };

  const { data: handoff, error: handoffError } = await sb.from('marketplace_handoffs')
    .select('id, proposer_role, status, meet_at, location_label').eq('order_id', orderId).maybeSingle();
  if (handoffError) return actionFailure('load the pickup', t('handoff.couldNotLoadThePickup'), handoffError);
  if (!handoff) return { ok: false, error: t('actions.noPickupToConfirm') };
  if (handoff.status !== 'proposed') return { ok: false, error: t('actions.thisPickupCanTBe') };
  if (role === handoff.proposer_role) return { ok: false, error: t('actions.waitForTheOtherPerson') };
  if (seen && !sameProposal(handoff, seen)) return { ok: false, error: t('handoff.pickupChangedRefresh') };

  const code = generateHandoffCode();

  // Best-effort: put the pickup on the family calendar.
  let calendarEventId: string | null = null;
  if (handoff.meet_at) {
    try {
      // The confirming party's own calendar: on an order between two
      // households, order.family_id is the seller's, which the buyer's
      // family cannot write to.
      const { data: ev } = await sb.from('calendar_events').insert({
        family_id: ctx.active.familyId,
        title: `Marketplace pickup${handoff.location_label ? ` · ${handoff.location_label}` : ''}`,
        description: 'Bubaly marketplace hand-off. Bring the item + the hand-off code.',
        location: handoff.location_label, category: 'general',
        starts_at: handoff.meet_at, created_by: ctx.user.id,
      }).select('id').single();
      calendarEventId = ev?.id ?? null;
    } catch { /* calendar optional — confirmation still succeeds */ }
  }

  // The `.eq('status', 'proposed')` predicate is what makes zero rows ORDINARY
  // here rather than exotic: if the other party confirmed or cancelled a moment
  // earlier, this matches nothing and returns no error. Without `.select('id')`
  // the action still answered `{ ok: true, data: { code } }` — handing back a
  // freshly minted hand-off code that was never stored. `completeHandoffAction`
  // validates against the STORED `confirm_code`, so the two of them would meet
  // in person, for a marketplace pickup with a stranger, holding a code that
  // could never work. Audit C1-S9-23.
  // The time and place are predicated too: a reschedule keeps the status
  // 'proposed', and one landing after the read above would otherwise be
  // confirmed under the event made from the superseded time.
  const { data: confirmed, error } = await sb.from('marketplace_handoffs').update({
    status: 'confirmed', confirmed_at: new Date().toISOString(), confirm_code: code,
    calendar_event_id: calendarEventId,
  }).eq('order_id', orderId).eq('family_id', order.family_id)
    .filter('meet_at', handoff.meet_at === null ? 'is' : 'eq', handoff.meet_at)
    .filter('location_label', handoff.location_label === null ? 'is' : 'eq', handoff.location_label)
    .eq('status', 'proposed').select('id');
  if (error) return actionFailure('confirm the pickup', t('handoff.couldNotConfirmThePickup'), error);
  if (wroteNoRows(confirmed)) {
    // The event above went in before this claim, and the claim matched nothing:
    // left there, it is on the calendar for a pickup nobody confirmed. (An
    // error is not handled the same way: a request that failed in transit may
    // still have landed, and then this event is the confirmed pickup's own.)
    await removePickupFromCalendar(sb, ctx.active.familyId, calendarEventId);
    return { ok: false, error: t('handoff.couldNotConfirmThePickup') };
  }

  revalidatePath('/marketplace/orders');
  return { ok: true, data: { code } };
}

/** Cancel a proposed/confirmed pickup (either party). */
export async function cancelHandoffAction(orderId: string): Promise<Result> {
  const t = await getTranslations();
  const { ctx, sb, order, orderError, role } = await loadOrderRole(orderId);
  if (orderError) return actionFailure('load the order', t('marketplace.couldNotLoadTheOrder'), orderError);
  if (!order) return { ok: false, error: t('actions.orderNotFound') };
  if (!role) return { ok: false, error: t(COMPLETE_REASON.forbidden) };
  // The Cancel control only renders for `proposed` or `confirmed`, so this filter
  // matching nothing means the state moved under the viewer — most often the other
  // party COMPLETED the pickup. Answering `{ ok: true }` then popped "Pickup
  // cancelled" over a hand-off that just finished, and the two of them would be
  // reading opposite outcomes of the same meeting. Audit C1-S9-59.
  const { data: cancelled, error } = await sb.from('marketplace_handoffs').update({ status: 'cancelled' })
    .eq('order_id', orderId).eq('family_id', order.family_id).in('status', ['proposed', 'confirmed']).select('id, calendar_event_id');
  if (error) return actionFailure('cancel the pickup', t('handoff.couldNotCancelThePickup'), error);
  if (wroteNoRows(cancelled)) return { ok: false, error: t('handoff.couldNotCancelThePickup') };
  // The event id comes from the row this update cancelled, not an earlier read,
  // so it is the confirmed pickup's own event and never a newer one's. The
  // event is in the confirmer's family (see confirm), so it is removed from
  // the caller's own; between two households, the other side's copy is
  // theirs to remove and a miss is logged.
  await removePickupFromCalendar(sb, ctx.active.familyId, cancelled?.[0]?.calendar_event_id);
  revalidatePath('/marketplace/orders');
  return { ok: true };
}

type LoadedOrder = NonNullable<Awaited<ReturnType<typeof loadOrderRole>>['order']>;
type ConfirmedHandoff = { id: string; confirm_code: string | null };

/**
 * A rent or a borrow STARTS at its pickup: the hand-off code moves the order
 * from 'confirmed' to 'active' (the Orders page's "Start"), and the loan runs
 * until the lender marks it returned or complete. marketplace_complete_handoff
 * (0483) writes 'completed' for every kind, which recorded the loan as over
 * the moment it began: the return was never tracked, the lender had no
 * "Mark returned" left, and the return-reminder cron never selected the order
 * again. Until the owner's SQL makes the function start a loan instead, the
 * app does not call it for one. Both writes are claimed on the state they were
 * decided from, the hand-off before the order; either party may start an order
 * (0518 leaves 'active' to both).
 */
async function startLoanAtPickup(
  sb: Awaited<ReturnType<typeof loadOrderRole>>['sb'],
  t: Awaited<ReturnType<typeof getTranslations>>,
  order: LoadedOrder, handoff: ConfirmedHandoff, code: string, actorFamilyId: string,
): Promise<Result<{ loanStarted: boolean }>> {
  if (order.status !== 'confirmed' && order.status !== 'active') return { ok: false, error: t(COMPLETE_REASON.order_not_open) };
  const stored = handoff.confirm_code;
  if (!stored || !codesMatch(code, stored)) return { ok: false, error: t(COMPLETE_REASON.code_mismatch) };

  // The hand-off is claimed FIRST. Only one call can win it, so a second submit
  // (the same proposer in another tab) stops here having changed nothing. The
  // order used to go first, and its undo was what broke: B saw the order A had
  // just started, skipped it and won the hand-off; A's claim then matched
  // nothing and put the picked-up loan back to 'confirmed'.
  const completedAt = new Date().toISOString();
  const { data: picked, error } = await sb.from('marketplace_handoffs')
    .update({ status: 'completed', completed_at: completedAt })
    .eq('id', handoff.id).eq('family_id', order.family_id).eq('status', 'confirmed').eq('confirm_code', stored)
    .select('id');
  if (error) return actionFailure('complete the pickup', t('actions.couldNotCompleteThePickup'), error);
  // The pickup was cancelled or finished a moment ago: nothing was handed over here.
  if (wroteNoRows(picked)) return { ok: false, error: t('handoff.pickupChangedRefresh') };

  // Then the loan starts. 'active' already (either party's "Start") is started.
  const { data: started, error: startError } = await sb.from('marketplace_orders').update({ status: 'active' })
    .eq('id', order.id).eq('family_id', order.family_id).in('status', ['confirmed', 'active']).select('id');
  if (startError) return actionFailure('start the loan', t('actions.couldNotCompleteThePickup'), startError);
  if (wroteNoRows(started)) {
    // The order is no longer confirmed or active: it was cancelled (or closed)
    // since it was read. So the pickup this call completed is taken down, not
    // put back to 'confirmed': the order's own cancel, landing after the claim
    // above, found no open pickup to cancel, and a reopened pickup was a live
    // code and a calendar event on an order that is off. The claim is
    // this call's alone and the take-down is predicated on it, so it cannot
    // touch anyone else's. The event is in the confirmer's family; between two
    // households that copy is theirs to remove, and a miss is logged.
    const { data: undone, error: undoError } = await sb.from('marketplace_handoffs').update({ status: 'cancelled', completed_at: null })
      .eq('id', handoff.id).eq('family_id', order.family_id).eq('status', 'completed').eq('completed_at', completedAt)
      .select('id, calendar_event_id');
    if (undoError || wroteNoRows(undone)) console.error('[marketplace-handoff] could not take the pickup down', undoError ?? handoff.id);
    else await removePickupFromCalendar(sb, actorFamilyId, undone?.[0]?.calendar_event_id);
    return { ok: false, error: t('handoff.pickupChangedRefresh') };
  }
  return { ok: true, data: { loanStarted: true } };
}

/**
 * Complete the hand-off in person: the PROPOSER enters the code → the order
 * moves on (a sale completes; a rent or a borrow starts).
 *
 * The code is minted when the other party confirms, returned to them and shown
 * on their screen alone, so it proves the two met only if the party entering
 * it is the one who did NOT confirm. Both used to see it and either could
 * enter it, so either one alone "completed in person": a borrower closed a
 * loan, and silenced its overdue reminders, with the item still in hand. The
 * handoffs SELECT policy (0483) still hands confirm_code to both parties over
 * PostgREST and the RPC still accepts either party; narrowing both is the
 * owner's SQL.
 */
export async function completeHandoffAction(input: { orderId: string; code: string }): Promise<Result<{ loanStarted: boolean }>> {
  const t = await getTranslations();
  // The RPC checks only that the caller is in the order's family, and the
  // hand-off code is readable family-wide, so a sibling who is neither party
  // could close someone else's pickup (and end a loan nobody exchanged). The
  // party check the other three actions make is made here too.
  const { ctx, sb, order, orderError, role } = await loadOrderRole(input.orderId);
  if (orderError) return actionFailure('load the order', t('marketplace.couldNotLoadTheOrder'), orderError);
  if (!order) return { ok: false, error: t('actions.orderNotFound') };
  if (!role) return { ok: false, error: t(COMPLETE_REASON.forbidden) };

  const { data: handoff, error: handoffError } = await sb.from('marketplace_handoffs')
    .select('id, proposer_role, status, confirm_code').eq('order_id', order.id).eq('family_id', order.family_id).maybeSingle();
  if (handoffError) return actionFailure('load the pickup', t('handoff.couldNotLoadThePickup'), handoffError);
  if (!handoff) return { ok: false, error: t(COMPLETE_REASON.handoff_not_found) };
  if (handoff.status !== 'confirmed') return { ok: false, error: t(COMPLETE_REASON.handoff_not_ready) };
  // The confirmer holds the code; the proposer enters it.
  if (holdsHandoffCode(role, handoff.proposer_role as HandoffRole)) return { ok: false, error: t('handoff.theOtherPersonEntersTheCode') };

  if (isLoanKind(order.kind)) {
    const started = await startLoanAtPickup(sb, t, order, handoff, input.code, ctx.active.familyId);
    if (started.ok) revalidatePath('/marketplace/orders');
    return started;
  }

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
