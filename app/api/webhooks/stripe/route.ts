import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/server';
import type Stripe from 'stripe';

export const runtime = 'nodejs';

async function upsertSubscription(supabase: ReturnType<typeof createServiceClient>, sub: Stripe.Subscription) {
  const familyId = sub.metadata.family_id;
  if (!familyId) return;

  const item = sub.items.data[0];
  const priceId = item?.price.id ?? '';

  // Map price → plan slug
  const plan =
    priceId === process.env.STRIPE_PRICE_FAMILY_MONTHLY ? 'family' :
    priceId === process.env.STRIPE_PRICE_FAMILY_ANNUAL ? 'family_annual' :
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
      break;
    }
  }

  return NextResponse.json({ received: true });
}
