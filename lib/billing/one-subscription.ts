// lib/billing/one-subscription.ts — a family pays for one subscription.
//
// A Stripe Checkout Session in `subscription` mode creates a new subscription
// when it is paid, whatever the customer already has. So two things can bill a
// family twice, and neither is visible in our own `subscriptions` row:
//
//  - A subscription Stripe already holds that the row has not caught up with:
//    its webhook is still in flight, or failed and is being retried. The billing
//    page reads the row, still offers the plans, and a second Checkout starts a
//    second subscription.
//  - An older Checkout Session that is still open. A session stays payable for
//    24 hours, so a second tab, or the browser's back button to Stripe's page,
//    can pay it after another session has already been paid.
//
// Both routes that start a Checkout ask this first, once the customer they will
// charge is known. It closes the customer's older open subscription sessions
// BEFORE it lists their subscriptions, so a session completed while it ran is
// either expired in time or caught: Stripe refuses to expire a completed session,
// and the subscription that session created is then in the list.
//
// Limits, stated rather than papered over:
//  - Stripe is asked per CUSTOMER. Two first-ever requests for one family that
//    race can each create their own customer (lib/billing/customer-ref.ts), and
//    neither sees the other's session.
//  - Two requests in the same instant can each create a session the other's
//    listing missed. Each answers its own tab, so a double click leaves one
//    session nobody is shown; only two tabs opened in the same instant can still
//    each pay.
import { canChangeSubscriptionInPlace } from '@/lib/billing/plans';

/** The slice of the Stripe client this needs; the real client satisfies it. */
export type OneSubscriptionStripe = {
  subscriptions: {
    list(params: { customer: string; status: 'all'; limit: number }): Promise<{ data: { id: string; status: string }[]; has_more?: boolean }>;
  };
  checkout: {
    sessions: {
      list(params: { customer: string; status: 'open'; limit: number }): Promise<{ data: { id: string; mode?: string | null }[]; has_more?: boolean }>;
      expire(id: string): Promise<unknown>;
      retrieve(id: string): Promise<{ id: string; status?: string | null }>;
    };
  };
};

export type NewSubscriptionCheck =
  /** Nothing would be duplicated: a Checkout may start. */
  | { ok: true }
  /** Stripe already bills, or is about to bill, this customer for a subscription. */
  | { ok: false; reason: 'subscribed' }
  /** Stripe could not be asked, or did not answer in full. Start nothing. */
  | { ok: false; reason: 'unavailable' };

/** At most this many of a customer's sessions or subscriptions are read; more is answered `unavailable`. */
const PAGE = 100;

/**
 * Whether a new subscription Checkout for `customerRef` could start a second
 * subscription. Expires the customer's older open subscription sessions as it
 * goes, so the session about to be created is the only one that can be paid.
 * Never throws: a failed or partial answer is `unavailable`.
 */
export async function checkNewSubscription(stripe: OneSubscriptionStripe, customerRef: string): Promise<NewSubscriptionCheck> {
  try {
    const open = await stripe.checkout.sessions.list({ customer: customerRef, status: 'open', limit: PAGE });
    // A page we did not read could hold a session that is still payable.
    if (open.has_more) {
      console.error('[billing] more open Checkout sessions than one page; starting no new one', { customerRef });
      return { ok: false, reason: 'unavailable' };
    }
    for (const session of open.data) {
      if (session.mode !== 'subscription') continue;
      try {
        await stripe.checkout.sessions.expire(session.id);
      } catch (expireError) {
        // Stripe refuses to expire a session that is no longer open. Ask what
        // it became: expired by a request racing this one is fine; completed
        // means a subscription was just created.
        const now = await stripe.checkout.sessions.retrieve(session.id);
        if (now.status === 'complete') return { ok: false, reason: 'subscribed' };
        if (now.status !== 'expired') {
          console.error('[billing] could not close an older open Checkout session', { customerRef, session: session.id }, expireError);
          return { ok: false, reason: 'unavailable' };
        }
      }
    }

    const subscriptions = await stripe.subscriptions.list({ customer: customerRef, status: 'all', limit: PAGE });
    if (subscriptions.data.some((sub) => canChangeSubscriptionInPlace({ status: sub.status, provider_ref: sub.id }))) {
      return { ok: false, reason: 'subscribed' };
    }
    // Newest first, so a live one is almost always on the first page; but
    // "almost" is not an answer to "would this charge them twice".
    if (subscriptions.has_more) {
      console.error('[billing] more subscriptions than one page and none live on it; starting no new one', { customerRef });
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true };
  } catch (error) {
    console.error('[billing] could not ask Stripe whether a Checkout would duplicate a subscription', { customerRef }, error);
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * The family's OTHER live subscriptions that are not already set to end, across
 * every customer it may have (lib/billing/customer-ref.ts records a race that
 * leaves a family with two). What cancelling the plan has to stop besides the
 * one the family's row follows. A customer Stripe no longer has bills nobody;
 * any other failure throws.
 */
export async function otherLiveFamilySubscriptions(
  stripe: { subscriptions: { list(params: { customer: string; status: 'all'; limit: number }): Promise<{ data: { id: string; status: string; cancel_at_period_end?: boolean | null; metadata?: Record<string, string> | null }[] }> } },
  customerRefs: (string | null | undefined)[],
  familyId: string,
  excludeId: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const customer of [...new Set(customerRefs.filter((c): c is string => Boolean(c)))]) {
    let listed: Awaited<ReturnType<typeof stripe.subscriptions.list>>;
    try {
      listed = await stripe.subscriptions.list({ customer, status: 'all', limit: PAGE });
    } catch (error) {
      if ((error as { code?: string })?.code === 'resource_missing') continue;
      throw error;
    }
    for (const sub of listed.data) {
      if (sub.id === excludeId || sub.cancel_at_period_end || sub.metadata?.family_id !== familyId) continue;
      if (canChangeSubscriptionInPlace({ status: sub.status, provider_ref: sub.id })) ids.push(sub.id);
    }
  }
  return ids;
}
