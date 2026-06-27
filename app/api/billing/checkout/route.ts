import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { stripeFromKey, STRIPE_PLANS, type StripePlan } from '@/lib/stripe';
import { getStripeSettings, effectiveSecretKey } from '@/lib/stripe/settings';
import { serviceFeeAddInvoiceItems } from '@/lib/stripe/service-fee';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const supabase = await createServer();
    const stripeSettings = await getStripeSettings();
    const stripe = stripeFromKey(effectiveSecretKey(stripeSettings));

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
        // The Bubaly service fee, added as a one-time charge on the first
        // invoice (configured in Super Admin → Stripe Setup). Doesn't touch the
        // recurring plan item, so webhook plan-mapping stays correct.
        ...(serviceFeeAddInvoiceItems(stripeSettings) ? { add_invoice_items: serviceFeeAddInvoiceItems(stripeSettings) } : {}),
      },
      allow_promotion_codes: true,
    });

    // Record the open checkout so the abandoned-checkout cron can follow up if
    // it's never completed. Best-effort: never block returning the checkout URL.
    try {
      await createServiceClient().from('checkout_sessions').insert({
        session_id: session.id,
        family_id: familyId,
        email: ctx.user.email ?? null,
        name: ctx.active.family.name ?? null,
        plan,
        status: 'pending',
      });
    } catch {
      /* non-fatal */
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    return NextResponse.json({ error: 'Could not create checkout session' }, { status: 500 });
  }
}
