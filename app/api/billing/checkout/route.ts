import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { getStripe, STRIPE_PLANS, type StripePlan } from '@/lib/stripe';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const supabase = await createServer();
    const stripe = getStripe();

    const { plan } = await req.json() as { plan: StripePlan };
    const priceId = STRIPE_PLANS[plan];
    if (!priceId) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });

    // Get or create Stripe customer
    const { data: existing } = await supabase
      .from('billing_customers')
      .select('customer_ref')
      .eq('family_id', familyId)
      .maybeSingle();

    let customerId = existing?.customer_ref ?? null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        ...(ctx.user.email ? { email: ctx.user.email } : {}),
        name: ctx.active.family.name,
        metadata: { family_id: familyId, user_id: ctx.user.id },
      });
      customerId = customer.id;

      await supabase.from('billing_customers').upsert({
        family_id: familyId,
        provider: 'stripe',
        customer_ref: customerId,
      });
    }

    const origin = req.headers.get('origin') ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/dashboard/billing?success=1`,
      cancel_url: `${origin}/dashboard/billing`,
      metadata: { family_id: familyId },
      subscription_data: {
        metadata: { family_id: familyId },
      },
      allow_promotion_codes: true,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    return NextResponse.json({ error: 'Could not create checkout session' }, { status: 500 });
  }
}
