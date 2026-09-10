import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { getUserContext, requireUserContext, type UserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { getStripe, STRIPE_PLANS } from '@/lib/stripe';
import { isAdmin } from '@/lib/constants/roles';
import { canChangeSubscriptionInPlace, slugToStripePlan } from '@/lib/billing/plans';
import { canonicalStripePlan, isStripePlanKey, verifyStripePlanPrice } from '@/lib/billing/price-catalog';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';

const MAX_BILLING_REQUEST_BYTES = 4_096;

export const runtime = 'nodejs';

/**
 * Self-serve plan change: upgrade/downgrade tier or switch monthly↔annual.
 * If the family already has a live Stripe subscription we update its price in
 * place (prorated) — no second subscription, no portal round-trip. If they're on
 * Free we fall back to Checkout. Family admins (parents) only.
 */
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const body = await readBoundedRequestJson(req, MAX_BILLING_REQUEST_BYTES);
    if (!body.ok) {
      return NextResponse.json(
        { error: body.reason === 'too_large' ? 'Request body too large.' : 'Invalid request body.' },
        { status: body.reason === 'too_large' ? 413 : 400 },
      );
    }
    const payload = body.value && typeof body.value === 'object' ? body.value : {};
    const { plan, expectedUserId, expectedFamilyId } = payload as { plan?: unknown; expectedUserId?: unknown; expectedFamilyId?: unknown };
    const assertedContext = Object.prototype.hasOwnProperty.call(payload, 'expectedUserId') || Object.prototype.hasOwnProperty.call(payload, 'expectedFamilyId');
    let ctx: UserContext;
    if (assertedContext) {
      if (typeof expectedUserId !== 'string' || !expectedUserId || typeof expectedFamilyId !== 'string' || !expectedFamilyId) {
        return NextResponse.json({ error: t('billingReview.contextChanged') }, { status: 400 });
      }
      // A review must not provision a family/trial for another account. Resolve
      // membership without the provisioning fallback in requireUserContext.
      let fresh: Awaited<ReturnType<typeof getUserContext>>;
      try { fresh = await getUserContext(); }
      catch {
        return NextResponse.json({ error: t('changePlan.subscriptionStatusIsTemporarilyUnavailable') }, { status: 503 });
      }
      if (!fresh || 'needsFamily' in fresh || expectedUserId !== fresh.user.id) {
        return NextResponse.json({ error: t('billingReview.contextChanged') }, { status: 409 });
      }
      // Ordinary navigation may fall back after a preference-read failure. A
      // paid review requires an authoritative active-family choice instead.
      let preferredFamilyId: string | null | undefined;
      try {
        const db = await createServer();
        const { data: preference, error } = await db.from('user_preferences').select('active_family_id').eq('user_id', fresh.user.id).maybeSingle();
        if (error) throw error;
        preferredFamilyId = preference?.active_family_id;
      } catch {
        return NextResponse.json({ error: t('changePlan.subscriptionStatusIsTemporarilyUnavailable') }, { status: 503 });
      }
      const active = preferredFamilyId
        ? fresh.memberships.find(membership => membership.familyId === preferredFamilyId)
        : fresh.memberships.length === 1 ? fresh.memberships[0] : undefined;
      if (!active || expectedFamilyId !== active.familyId) {
        return NextResponse.json({ error: t('billingReview.contextChanged') }, { status: 409 });
      }
      ctx = { ...fresh, active };
    } else {
      ctx = await requireUserContext();
    }
    if (!isAdmin(ctx.active.role)) {
      return NextResponse.json({ error: t('changePlan.onlyAParentCanChange') }, { status: 403 });
    }
    const familyId = ctx.active.familyId;
    if (!isStripePlanKey(plan)) {
      return NextResponse.json({ error: t('changePlan.invalidPlan') }, { status: 400 });
    }
    const priceId = STRIPE_PLANS[plan];
    if (!priceId) return NextResponse.json({ error: t('changePlan.thatPlanIsNotConfigured') }, { status: 400 });

    const supabase = await createServer();
    const limited = await enforceRequestRateLimit(supabase, `billing:change-plan:${familyId}:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: t('changePlan.tooManyBillingRequestsPlease') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
    const stripe = getStripe();

    if (!await verifyStripePlanPrice(stripe, plan, priceId)) {
      console.error('[billing-change-plan] Configured Stripe price is unavailable or does not match the plan');
      return NextResponse.json({ error: t('changePlan.subscriptionStatusIsTemporarilyUnavailable') }, { status: 503 });
    }

    const { data: sub, error: subError } = await supabase
      .from('subscriptions')
      .select('plan, status, provider_ref, cancel_at_period_end')
      .eq('family_id', familyId)
      .maybeSingle();
    if (subError) {
      console.error('[billing-change-plan] Subscription read failed', subError);
      return NextResponse.json({ error: t('changePlan.subscriptionStatusIsTemporarilyUnavailable') }, { status: 503 });
    }

    // In-place modification when a modifiable Stripe subscription exists.
    if (canChangeSubscriptionInPlace(sub)) {
      const stripeSub = await stripe.subscriptions.retrieve(sub.provider_ref);
      const item = stripeSub.items.data[0];
      const itemId = item?.id;
      if (!itemId) return NextResponse.json({ error: t('changePlan.noSubscriptionItemFound') }, { status: 409 });
      if (!canChangeSubscriptionInPlace({ status: stripeSub.status, provider_ref: stripeSub.id })) {
        return NextResponse.json({ error: t('changePlan.subscriptionStatusIsTemporarilyUnavailable') }, { status: 503 });
      }
      // A prior provider update can precede its local webhook. Read Stripe's
      // actual item before treating a retry as another paid subscription change.
      if (item.price.id === priceId && !stripeSub.cancel_at_period_end) {
        const providerUpdated = slugToStripePlan(sub.plan) !== canonicalStripePlan(plan) || sub.cancel_at_period_end;
        return NextResponse.json({ ok: true, changed: false, providerUpdated, providerRef: stripeSub.id,
          message: providerUpdated ? t('changePlan.stripeChangedThePlanBut') : 'You are already on this plan.' });
      }

      await stripe.subscriptions.update(sub.provider_ref, {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: 'create_prorations',
        cancel_at_period_end: false, // changing plan clears any scheduled cancel
        metadata: { family_id: familyId },
      });

      // Optimistic local sync; the customer.subscription.updated webhook confirms.
      try {
        const { error: syncError } = await createServiceClient()
          .from('subscriptions')
          .update({ cancel_at_period_end: false })
          .eq('family_id', familyId);
        if (syncError) throw syncError;
      } catch (syncError) {
        console.error('[billing-change-plan] Subscription sync write failed', syncError);
        return NextResponse.json({ error: t('changePlan.stripeChangedThePlanBut'), providerUpdated: true, providerRef: stripeSub.id }, { status: 503 });
      }

      return NextResponse.json({ ok: true, changed: true, mode: 'updated', providerRef: stripeSub.id });
    }

    // No live subscription (Free / canceled) → start Checkout.
    const { data: bc, error: billingCustomerError } = await supabase
      .from('billing_customers')
      .select('customer_ref')
      .eq('family_id', familyId)
      .maybeSingle();
    if (billingCustomerError) {
      console.error('[billing-change-plan] Billing customer read failed', billingCustomerError);
      return NextResponse.json({ error: t('changePlan.billingAccountStatusIsTemporarily') }, { status: 503 });
    }

    let customerId = bc?.customer_ref ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        ...(ctx.user.email ? { email: ctx.user.email } : {}),
        name: ctx.active.family.name,
        metadata: { family_id: familyId, user_id: ctx.user.id },
      });
      customerId = customer.id;
      const { error: customerWriteError } = await supabase.from('billing_customers').upsert({ family_id: familyId, provider: 'stripe', customer_ref: customerId });
      if (customerWriteError) {
        console.error('[billing-change-plan] Billing customer write failed', customerWriteError);
        return NextResponse.json({ error: t('changePlan.couldNotSaveTheBilling') }, { status: 503 });
      }
    }

    // PAY-5: trusted configured base first, not the caller-controlled Origin header.
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? req.headers.get('origin') ?? 'http://localhost:3000';
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/dashboard/billing?success=1`,
      cancel_url: `${origin}/dashboard/billing`,
      metadata: { family_id: familyId, plan },
      subscription_data: { metadata: { family_id: familyId } },
      allow_promotion_codes: true,
    });

    try {
      const { error: trackingError } = await createServiceClient().from('checkout_sessions').insert({
        session_id: session.id, family_id: familyId, email: ctx.user.email ?? null,
        name: ctx.active.family.name ?? null, plan, status: 'pending',
      });
      if (trackingError) console.error('[billing-change-plan] Checkout tracking write failed', trackingError);
    } catch (error) { console.error('[billing-change-plan] Checkout tracking write failed', error); }

    return NextResponse.json({ ok: true, changed: false, mode: 'checkout', url: session.url });
  } catch (err) {
    console.error('change-plan error:', err);
    return NextResponse.json({ error: t('changePlan.couldNotChangeThePlan') }, { status: 500 });
  }
}
