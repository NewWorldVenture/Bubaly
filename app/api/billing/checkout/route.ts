import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { stripeFromKey, STRIPE_PLANS, type StripePlan } from '@/lib/stripe';
import { getStripeSettings, effectiveSecretKey } from '@/lib/stripe/settings';
import { serviceFeeAddInvoiceItems } from '@/lib/stripe/service-fee';
import { isAdmin } from '@/lib/constants/roles';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';

const MAX_BILLING_REQUEST_BYTES = 4_096;

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    // PAY-3: only a family admin (parent) may start a paid subscription — the
    // same gate change-plan/cancel already enforce.
    if (!isAdmin(ctx.active.role)) {
      return NextResponse.json({ error: 'Only a parent can start a subscription.' }, { status: 403 });
    }
    const familyId = ctx.active.familyId;
    const supabase = await createServer();
    const stripeSettings = await getStripeSettings();
    const stripe = stripeFromKey(effectiveSecretKey(stripeSettings));

    const body = await readBoundedRequestJson(req, MAX_BILLING_REQUEST_BYTES);
    if (!body.ok) {
      return NextResponse.json(
        { error: body.reason === 'too_large' ? 'Request body too large.' : 'Invalid request body.' },
        { status: body.reason === 'too_large' ? 413 : 400 },
      );
    }
    const { plan } = (body.value && typeof body.value === 'object' ? body.value : {}) as { plan?: StripePlan };
    const priceId = plan ? STRIPE_PLANS[plan] : undefined;
    if (!priceId) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });

    const limited = await enforceRequestRateLimit(supabase, `billing:checkout:${familyId}:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: 'Too many billing requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    // Get or create Stripe customer
    const { data: existing, error: existingError } = await supabase
      .from('billing_customers')
      .select('customer_ref')
      .eq('family_id', familyId)
      .maybeSingle();
    if (existingError) {
      console.error('[billing-checkout] Billing customer read failed', existingError);
      return NextResponse.json({ error: 'Billing account status is temporarily unavailable.' }, { status: 503 });
    }

    let customerId = existing?.customer_ref ?? null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        ...(ctx.user.email ? { email: ctx.user.email } : {}),
        name: ctx.active.family.name,
        metadata: { family_id: familyId, user_id: ctx.user.id },
      });
      customerId = customer.id;

      const { error: customerWriteError } = await supabase.from('billing_customers').upsert({
        family_id: familyId,
        provider: 'stripe',
        customer_ref: customerId,
      });
      if (customerWriteError) {
        console.error('[billing-checkout] Billing customer write failed', customerWriteError);
        return NextResponse.json({ error: 'Could not save the billing account. Please try again.' }, { status: 503 });
      }
    }

    // PAY-5: build success/cancel URLs from the trusted configured base, not the
    // caller-controlled Origin header (only fall back to it when unset in dev).
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? req.headers.get('origin') ?? 'http://localhost:3000';

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/dashboard/billing?success=1`,
      cancel_url: `${origin}/dashboard/billing`,
      metadata: { family_id: familyId, plan: plan ?? null },
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
      const { error: trackingError } = await createServiceClient().from('checkout_sessions').insert({
        session_id: session.id,
        family_id: familyId,
        email: ctx.user.email ?? null,
        name: ctx.active.family.name ?? null,
        plan,
        status: 'pending',
      });
      if (trackingError) console.error('[billing-checkout] Checkout tracking write failed', trackingError);
    } catch (error) {
      console.error('[billing-checkout] Checkout tracking write failed', error);
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    return NextResponse.json({ error: 'Could not create checkout session' }, { status: 500 });
  }
}
