import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/server';
import { markReferralConverted } from '@/lib/referrals/server';
import { isNewPaidConversion } from '@/lib/billing/conversion';
import { recordEvent, markEventProcessed, markEventError } from '@/lib/stripe/webhook';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import { readBoundedRequestText } from '@/lib/server/bounded-request-body';
import type Stripe from 'stripe';

export const runtime = 'nodejs';
const MAX_WEBHOOK_BODY_BYTES = 256_000;

async function upsertSubscription(supabase: ReturnType<typeof createServiceClient>, sub: Stripe.Subscription) {
  const familyId = sub.metadata.family_id;
  if (!familyId) return;

  const item = sub.items.data[0];
  const priceId = item?.price.id ?? '';

  // Map price → plan slug
  const plan =
    priceId === process.env.STRIPE_PRICE_PLUS_MONTHLY   ? 'plus' :
    priceId === process.env.STRIPE_PRICE_PLUS_ANNUAL    ? 'plus_annual' :
    priceId === process.env.STRIPE_PRICE_BASIC_MONTHLY  ? 'basic' :
    priceId === process.env.STRIPE_PRICE_BASIC_ANNUAL   ? 'basic_annual' :
    // Legacy price IDs (backward-compat with existing subscriptions)
    priceId === process.env.STRIPE_PRICE_FAMILY_MONTHLY ? 'basic' :
    priceId === process.env.STRIPE_PRICE_FAMILY_ANNUAL  ? 'basic_annual' :
    'free';

  // Resolve billing_customer_id + the PRIOR subscription state (to detect a
  // brand-new paid conversion vs. a routine renewal).
  const [{ data: bc, error: billingCustomerError }, { data: priorSub }] = await Promise.all([
    supabase.from('billing_customers').select('id').eq('family_id', familyId).maybeSingle(),
    supabase.from('subscriptions').select('plan, status').eq('family_id', familyId).maybeSingle(),
  ]);
  if (billingCustomerError) throw new Error('Billing customer lookup failed');

  const { error: subscriptionError } = await supabase.from('subscriptions').upsert(
    {
      family_id: familyId,
      billing_customer_id: bc?.id ?? null,
      plan,
      status: sub.status as 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid',
      provider_ref: sub.id,
      current_period_end: new Date((sub as unknown as { current_period_end: number }).current_period_end * 1000).toISOString(),
      cancel_at_period_end: sub.cancel_at_period_end ?? false,
      seats: 10,
    },
    { onConflict: 'family_id' },
  );
  if (subscriptionError) throw new Error('Subscription persistence failed');

  // Credit a pending referral when a referred family first becomes paid.
  if (plan !== 'free' && (sub.status === 'active' || sub.status === 'trialing')) {
    try { await markReferralConverted(supabase, familyId); }
    catch (e) { console.error('[referral] conversion crediting failed', e); }
  }

  // 🎉 Alert the super admin on a NEW paid conversion (not renewals). Best-effort.
  if (isNewPaidConversion(priorSub, { plan, status: sub.status })) {
    try {
      const { recordAdminNotification } = await import('@/lib/admin/notify');
      const { data: fam } = await supabase.from('families').select('name').eq('id', familyId).maybeSingle();
      await recordAdminNotification(supabase, {
        kind: 'subscription',
        title: `New paid conversion: ${fam?.name ?? 'a family'}`,
        body: `Upgraded to ${plan} (${sub.status}).`,
        url: '/admin/subscriptions',
        relatedType: 'subscription', relatedId: familyId,
        meta: { plan, status: sub.status },
      });
    } catch (e) { console.error('[admin-notify] paid-conversion alert failed', e); }
  }
}

export async function POST(req: NextRequest) {
  const boundedBody = await readBoundedRequestText(req, MAX_WEBHOOK_BODY_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Payload too large' : 'Unable to read payload' }, { status: boundedBody.reason === 'too_large' ? 413 : 400 });
  const body = boundedBody.text;
  const sig = req.headers.get('stripe-signature') ?? '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
  if (!webhookSecret) return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    return NextResponse.json({ error: 'Webhook signature invalid' }, { status: 400 });
  }

  const supabase = createServiceClient();

  // PAY-4: dedup by Stripe event id so a re-delivered event isn't processed
  // twice (reuses the replay-safe store from PAY-2). A fully-processed event
  // short-circuits; a prior failed/unfinished one is reprocessed.
  let claimToken = '';
  try {
    const claim = await recordEvent(supabase, event);
    if (claim.outcome === 'duplicate') {
      return NextResponse.json({ received: true, duplicate: true });
    }
    claimToken = claim.claimToken ?? '';
    if (!claimToken) return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });
  } catch {
    return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await upsertSubscription(supabase, event.data.object as Stripe.Subscription);
        break;
      }

      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Response<Stripe.Checkout.Session>;
        // Ensure billing_customer row has the customer_ref
        const familyId = session.metadata?.family_id;
        if (familyId && session.customer) {
          const { error: billingCustomerError } = await supabase.from('billing_customers').upsert(
            { family_id: familyId, provider: 'stripe', customer_ref: String(session.customer) },
            { onConflict: 'family_id' },
          );
          if (billingCustomerError) throw new Error('Billing customer persistence failed');
        }
        // Close out the tracked checkout so the abandoned-checkout cron skips it.
        const { data: checkout, error: checkoutError } = await supabase
          .from('checkout_sessions')
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('session_id', session.id).select('id').maybeSingle();
        if (checkoutError || !checkout) throw new Error('Checkout persistence failed');
        // Fire event-driven "payment_completed" automation workflows (deduped by
        // the Stripe session id). Best-effort: never fail the webhook on it.
        try {
          const buyerEmail = session.customer_details?.email ?? session.customer_email ?? null;
          await fireAutomationEvent(supabase, {
            trigger: 'payment_completed',
            email: buyerEmail,
            name: session.customer_details?.name ?? null,
            subjectKey: eventSubjectKey('payment_completed', [session.id]),
            context: { familyId: familyId ?? null, sessionId: session.id },
          });
        } catch {
          /* non-fatal */
        }
        break;
      }
    }
  } catch (err) {
    // Leave the event reprocessable and return 500 so Stripe retries it, rather
    // than 200'ing on a dropped subscription update.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await markEventError(supabase, event.id, message, claimToken);
    } catch (markError) {
      console.error('[stripe webhook] failed to record handler error', markError);
    }
    console.error('[stripe webhook] handler error', message);
    return NextResponse.json({ error: 'handler failed' }, { status: 500 });
  }

  try {
    await markEventProcessed(supabase, event.id, claimToken);
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('[stripe webhook] failed to finalize event', err);
    return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });
  }
}
