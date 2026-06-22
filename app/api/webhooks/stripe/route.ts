import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/server';
import { markReferralConverted } from '@/lib/referrals/server';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import type Stripe from 'stripe';

export const runtime = 'nodejs';

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

  // Resolve billing_customer_id
  const { data: bc } = await supabase
    .from('billing_customers')
    .select('id')
    .eq('family_id', familyId)
    .maybeSingle();

  await supabase.from('subscriptions').upsert(
    {
      family_id: familyId,
      billing_customer_id: bc?.id ?? null,
      plan,
      status: sub.status as 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid',
      provider_ref: sub.id,
      current_period_end: new Date((sub as unknown as { current_period_end: number }).current_period_end * 1000).toISOString(),
      seats: 10,
    },
    { onConflict: 'family_id' },
  );

  // Credit a pending referral when a referred family first becomes paid.
  if (plan !== 'free' && (sub.status === 'active' || sub.status === 'trialing')) {
    try { await markReferralConverted(supabase, familyId); }
    catch (e) { console.error('[referral] conversion crediting failed', e); }
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature') ?? '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '';

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    return NextResponse.json({ error: 'Webhook signature invalid' }, { status: 400 });
  }

  const supabase = createServiceClient();

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
        await supabase.from('billing_customers').upsert(
          { family_id: familyId, provider: 'stripe', customer_ref: String(session.customer) },
          { onConflict: 'family_id' },
        );
      }
      // Close out the tracked checkout so the abandoned-checkout cron skips it.
      await supabase
        .from('checkout_sessions')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('session_id', session.id);
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

  return NextResponse.json({ received: true });
}
