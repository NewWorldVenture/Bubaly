// lib/billing/subscription-checkout.ts — the one way a family's subscription
// Checkout is started, shared by /api/billing/checkout and the Free → Checkout
// branch of /api/billing/change-plan.
//
// The two routes used to build their own Checkout Sessions, and they drifted:
//  - change-plan never asked Stripe whether the customer already had a live
//    subscription (checkout did, PAY-DOUBLE-001), so a local row trailing the
//    webhook let it start a second, separately billed subscription;
//  - change-plan never added the Bubaly service fee that /dashboard/billing
//    discloses, so the fee depended on which button was pressed;
//  - neither reused the family's open session, so two tabs (the trial paywall
//    and the upgrade modal, or a client retry) produced two payable sessions
//    that could each complete into another billed subscription.
import 'server-only';
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import { canChangeSubscriptionInPlace } from '@/lib/billing/plans';
import { serviceFeeAddInvoiceItems, type ServiceFeeConfig } from '@/lib/stripe/service-fee';
import type { createServiceClient } from '@/lib/supabase/server';

type Admin = ReturnType<typeof createServiceClient>;

/** Does Stripe itself hold a live (active/trialing/past_due) subscription for this customer? */
export async function stripeCustomerHasLiveSubscription(stripe: Stripe, customerRef: string): Promise<boolean> {
  const listed = await stripe.subscriptions.list({ customer: customerRef, status: 'all', limit: 20 });
  return listed.data.some((sub) => canChangeSubscriptionInPlace({ status: sub.status, provider_ref: sub.id }));
}

/** Open sessions are payable for 24h; nothing older can still complete. */
const OPEN_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Requests for the same family+plan inside this window share one Stripe create. */
const IDEMPOTENCY_BUCKET_MS = 10 * 60 * 1000;

async function pendingSessionIds(admin: Admin, familyId: string, now: Date): Promise<{ session_id: string; plan: string | null }[]> {
  try {
    const { data, error } = await admin.from('checkout_sessions')
      .select('session_id, plan')
      .eq('family_id', familyId)
      .eq('status', 'pending')
      .gte('created_at', new Date(now.getTime() - OPEN_SESSION_WINDOW_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) throw error;
    return data ?? [];
  } catch (error) {
    // The tracking table is best-effort (its insert is), so an unreadable one
    // does not refuse the purchase; the idempotency key still collapses a
    // double submit of the same plan.
    console.error('[billing-checkout] Pending checkout read failed', error);
    return [];
  }
}

export type SubscriptionCheckoutInput = {
  familyId: string;
  customerId: string;
  priceId: string;
  plan: string;
  origin: string;
  settings: ServiceFeeConfig;
  now?: Date;
};

/**
 * Return a payable Checkout Session for this family and plan: the family's
 * still-open session for the same plan when there is one, otherwise a new one
 * after every other open session of theirs has been expired, so at most one
 * session per family can complete into a subscription.
 */
export async function createSubscriptionCheckout(
  stripe: Stripe, admin: Admin, input: SubscriptionCheckoutInput,
): Promise<{ id: string; url: string | null; reused: boolean }> {
  const now = input.now ?? new Date();
  const expired: string[] = [];
  for (const row of await pendingSessionIds(admin, input.familyId, now)) {
    const open = await stripe.checkout.sessions.retrieve(row.session_id);
    if (open.status !== 'open') continue;
    if (row.plan === input.plan && open.url) return { id: open.id, url: open.url, reused: true };
    await stripe.checkout.sessions.expire(open.id);
    expired.push(open.id);
  }

  const feeItems = serviceFeeAddInvoiceItems(input.settings);
  const params: Stripe.Checkout.SessionCreateParams = {
    customer: input.customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: input.priceId, quantity: 1 }],
    success_url: `${input.origin}/dashboard/billing?success=1`,
    cancel_url: `${input.origin}/dashboard/billing`,
    metadata: { family_id: input.familyId, plan: input.plan },
    subscription_data: {
      metadata: { family_id: input.familyId },
      // The Bubaly service fee, added as a one-time charge on the first
      // invoice (configured in Super Admin → Stripe Setup). Doesn't touch the
      // recurring plan item, so webhook plan-mapping stays correct.
      ...(feeItems ? { add_invoice_items: feeItems } : {}),
    },
    allow_promotion_codes: true,
  };
  // Two concurrent requests that both found nothing open get ONE session from
  // Stripe. The sessions this call expired are part of the key, so a later
  // return to a plan whose session was expired starts a fresh one rather than
  // replaying the expired one.
  const bucket = Math.floor(now.getTime() / IDEMPOTENCY_BUCKET_MS);
  const idempotencyKey = `bubaly-checkout-${createHash('sha256')
    .update([input.familyId, input.customerId, input.plan, input.priceId, bucket, ...expired].join('|'))
    .digest('hex').slice(0, 48)}`;
  const session = await stripe.checkout.sessions.create(params, { idempotencyKey });
  return { id: session.id, url: session.url, reused: false };
}
