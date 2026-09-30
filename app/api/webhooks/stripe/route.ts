import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { constructWebhookEvent, stripeFromKey } from '@/lib/stripe';
import { getStripeSettings, effectiveWebhookSecret, effectiveSecretKey, type StripeSettings } from '@/lib/stripe/settings';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { markReferralConverted, rewardConvertedReferral } from '@/lib/referrals/server';
import { isNewPaidConversion, isChurn } from '@/lib/billing/conversion';
import { catalogPlanForPrice } from '@/lib/billing/price-catalog';
import { rememberStripeCustomer } from '@/lib/billing/customer-ref';
import { recordEvent, markEventProcessed, markEventError } from '@/lib/stripe/webhook';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import { readBoundedRequestText } from '@/lib/server/bounded-request-body';
import type Stripe from 'stripe';

export const runtime = 'nodejs';
const MAX_WEBHOOK_BODY_BYTES = 256_000;

async function persistSubscription(supabase: ReturnType<typeof createServiceClient>, sub: Stripe.Subscription) {
  const familyId = sub.metadata.family_id;
  if (!familyId) return;

  const items = sub.items?.data;
  if (!Array.isArray(items) || items.length === 0) throw new Error('Subscription price is missing');
  // A partial list cannot establish that exactly one item grants entitlement.
  if (sub.items.has_more) throw new Error('Subscription items are incomplete');
  const recognized = items.map(item => {
    const priceId = typeof item?.price?.id === 'string' ? item.price.id : null;
    if (!priceId) throw new Error('Subscription price is missing');
    // Preserve current, historical and environment-configured price mappings.
    const plan = catalogPlanForPrice(priceId) ?? (
      priceId === process.env.STRIPE_PRICE_PLUS_MONTHLY   ? 'plus' :
      priceId === process.env.STRIPE_PRICE_PLUS_ANNUAL    ? 'plus_annual' :
      priceId === process.env.STRIPE_PRICE_BASIC_MONTHLY  ? 'basic' :
      priceId === process.env.STRIPE_PRICE_BASIC_ANNUAL   ? 'basic_annual' :
      // Legacy price IDs (backward-compat with existing subscriptions)
      priceId === process.env.STRIPE_PRICE_FAMILY_MONTHLY ? 'basic' :
      priceId === process.env.STRIPE_PRICE_FAMILY_ANNUAL  ? 'basic_annual' :
      null);
    return { item, plan };
  }).filter(({ plan }) => plan !== null);
  if (recognized.length > 1) throw new Error('Subscription plan items are ambiguous');
  const { item, plan } = recognized[0] ?? {};
  if (!plan) throw new Error('Unknown Stripe subscription price');

  // Resolve billing_customer_id + the PRIOR subscription state (to detect a
  // brand-new paid conversion vs. a routine renewal).
  const [{ data: bc, error: billingCustomerError }, { data: priorSub, error: priorSubscriptionError }] = await settleAll([
    supabase.from('billing_customers').select('id').eq('family_id', familyId).maybeSingle(),
    supabase.from('subscriptions').select('plan, status, provider_ref').eq('family_id', familyId).maybeSingle(),
  ]);
  if (billingCustomerError || priorSubscriptionError) {
    console.error('[stripe webhook] Billing state lookup failed', billingCustomerError ?? priorSubscriptionError);
    throw new Error('Billing state lookup failed');
  }

  // One row per family, many possible Stripe subscriptions over its life: a
  // resubscription after a cancellation, or a second subscription started
  // before checkout refused one (PAY-DOUBLE-001). An event about a subscription
  // that has ENDED must not overwrite a DIFFERENT subscription the row records
  // as live, or the family reads as canceled while it is still paying.
  const LIVE = ['active', 'trialing', 'past_due'];
  if (priorSub?.provider_ref && priorSub.provider_ref !== sub.id
    && LIVE.includes(priorSub.status) && !LIVE.includes(sub.status)) {
    console.warn('[stripe webhook] ignored an ended subscription that is not the family\'s live one', { familyId, ended: sub.id });
    return;
  }

  // Since Basil, periods belong to items. Persist the SAME item's plan and
  // period; neither another item's date nor a legacy top-level date is safe.
  const periodEnd = item.current_period_end;
  if (!Number.isSafeInteger(periodEnd) || periodEnd <= 0) throw new Error('Subscription item period is invalid');
  const periodEndDate = new Date(periodEnd * 1000);
  if (!Number.isFinite(periodEndDate.getTime())) throw new Error('Subscription item period is invalid');

  // `family_id` is deliberately not part of `fields`: it selects the row, and
  // the Update type withholds it so no code path can move a subscription
  // between families.
  const fields = {
    billing_customer_id: bc?.id ?? null,
    plan,
    status: sub.status as 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid',
    provider_ref: sub.id,
    current_period_end: periodEndDate.toISOString(),
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    seats: 10,
  };

  // Update-then-insert rather than upsert. `onConflict: 'family_id'` was never
  // satisfiable: there is no unique index on subscriptions.family_id, and
  // Postgres resolves an ON CONFLICT column list by index inference, so this
  // raised 42P10 at planning time on EVERY delivery — with the error swallowed
  // into a generic message that named the symptom and not the cause.
  //
  // 0285 declares the missing index, but only when no family already holds two
  // rows; it refuses to delete billing rows to make an index fit. This path is
  // written so it does not care either way — an update touches however many rows
  // the family has, and the insert runs only when it has none.
  const { data: updated, error: updateError } = await supabase
    .from('subscriptions').update(fields).eq('family_id', familyId).select('id');
  if (updateError) {
    console.error('[stripe webhook] Subscription update failed', updateError);
    throw new Error('Subscription persistence failed');
  }
  if (!updated || updated.length === 0) {
    const { error: insertError } = await supabase.from('subscriptions').insert({ family_id: familyId, ...fields });
    if (insertError) {
      console.error('[stripe webhook] Subscription insert failed', insertError);
      throw new Error('Subscription persistence failed');
    }
  }

  // Credit a pending referral when a referred family first becomes paid, then
  // fulfil it: both families' Stripe customer balances are credited and the
  // row flips to 'rewarded' only once Stripe confirms both (idempotent on
  // retries — see rewardReferral). Best-effort: never fails the webhook.
  if (sub.status === 'active' || sub.status === 'trialing') {
    try { await markReferralConverted(supabase, familyId); }
    catch (e) { console.error('[referral] conversion crediting failed', e); }
    try {
      const referredCustomerRef = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
      const reward = await rewardConvertedReferral(supabase, familyId, { referredCustomerRef });
      if (reward && reward.outcome !== 'rewarded' && reward.outcome !== 'already_rewarded') {
        console.warn('[referral] reward not completed on this event', reward);
      }
    } catch (e) { console.error('[referral] reward fulfilment failed', e); }
  }

  // Alert the super admin on the two growth transitions — a NEW paid conversion
  // (🎉, not renewals) and CHURN (📉, a paying family lost). Both best-effort.
  const nextState = { plan, status: sub.status };
  if (isNewPaidConversion(priorSub, nextState)) {
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
  } else if (isChurn(priorSub, nextState)) {
    try {
      const { recordAdminNotification } = await import('@/lib/admin/notify');
      const { data: fam } = await supabase.from('families').select('name').eq('id', familyId).maybeSingle();
      const lost = priorSub?.plan ?? 'a paid plan';
      await recordAdminNotification(supabase, {
        kind: 'subscription_churn',
        title: `Churn: ${fam?.name ?? 'a family'} left ${lost}`,
        body: `Subscription ${sub.status}.`,
        url: '/admin/subscriptions',
        relatedType: 'subscription', relatedId: familyId,
        meta: { from: lost, plan, status: sub.status },
      });
    } catch (e) { console.error('[admin-notify] churn alert failed', e); }
  }
}

// Stripe does not deliver events in order. An `updated` sent before a
// `deleted` can arrive after it, and the payload each carries is the
// subscription as it was when THAT event was created — so writing the payload
// let the older event land last and bring a canceled subscription back to
// active (PAY-ORDER-001). The event says only that something changed; what the
// row records is the subscription's state now, read from Stripe. An event for
// no Bubaly family is left as it came, since nothing is written for it.
async function currentSubscription(settings: StripeSettings | null, fromEvent: Stripe.Subscription): Promise<Stripe.Subscription> {
  if (!fromEvent.metadata?.family_id) return fromEvent;
  const secretKey = effectiveSecretKey(settings);
  // Without the key the current state cannot be read, and writing the payload
  // instead is the bug. Failing here returns 500, so Stripe retries once the
  // key is configured.
  if (!secretKey) throw new Error('Stripe secret key is not configured; the subscription\'s current state cannot be read');
  return stripeFromKey(secretKey).subscriptions.retrieve(fromEvent.id);
}

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const boundedBody = await readBoundedRequestText(req, MAX_WEBHOOK_BODY_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Payload too large' : 'Unable to read payload' }, { status: boundedBody.reason === 'too_large' ? 413 : 400 });
  const body = boundedBody.text;
  const sig = req.headers.get('stripe-signature') ?? '';
  // Super Admin → Stripe Setup's signing secret first, then the environment —
  // the order that page promises. Reading only the environment ignored a
  // secret saved there, and building the client with getStripe() threw when
  // STRIPE_SECRET_KEY was unset, which the catch below reported as a bad
  // signature: every real event refused, and no subscription ever recorded.
  const settings = await getStripeSettings();
  const webhookSecret = effectiveWebhookSecret(settings) ?? '';
  if (!webhookSecret) return NextResponse.json({ error: t('stripe.webhookNotConfigured') }, { status: 503 });

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(body, sig, webhookSecret);
  } catch (err) {
    return NextResponse.json({ error: t('stripe.webhookSignatureInvalid') }, { status: 400 });
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
    // Held by another delivery that has not finished. Not the same as done: a
    // 2xx here ends Stripe's retries for an event nobody has applied.
    if (claim.outcome === 'in_flight') {
      return NextResponse.json({ error: 'event_in_flight' }, { status: 409 });
    }
    claimToken = claim.claimToken ?? '';
    if (!claimToken) return NextResponse.json({ error: t('stripe.webhookStorageUnavailable') }, { status: 503 });
  } catch {
    return NextResponse.json({ error: t('stripe.webhookStorageUnavailable') }, { status: 503 });
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await persistSubscription(supabase, await currentSubscription(settings, event.data.object as Stripe.Subscription));
        break;
      }

      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Response<Stripe.Checkout.Session>;
        // Ensure billing_customer row has the customer_ref
        const familyId = session.metadata?.family_id;
        if (familyId && session.customer) {
          const written = await rememberStripeCustomer(supabase, familyId, String(session.customer));
          if (!written.ok) throw new Error('Billing customer persistence failed');
        }
        // Close out the tracked checkout so the abandoned-checkout cron skips it.
        // The initial tracking insert is intentionally best-effort because Stripe
        // already owns the session. Upsert here makes completion self-healing when
        // that insert failed or the webhook arrived first.
        const { error: checkoutError } = await supabase
          .from('checkout_sessions')
          .upsert({
            session_id: session.id,
            family_id: familyId ?? null,
            email: session.customer_details?.email ?? session.customer_email ?? null,
            name: session.customer_details?.name ?? null,
            plan: session.metadata?.plan ?? null,
            status: 'completed',
            completed_at: new Date().toISOString(),
          }, { onConflict: 'session_id' });
        if (checkoutError) throw new Error('Checkout persistence failed');
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
        } catch (error) {
          console.error('[stripe webhook] payment automation failed', error);
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
    return NextResponse.json({ error: t('stripe.handlerFailed') }, { status: 500 });
  }

  try {
    await markEventProcessed(supabase, event.id, claimToken);
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('[stripe webhook] failed to finalize event', err);
    return NextResponse.json({ error: t('stripe.webhookStorageUnavailable') }, { status: 503 });
  }
}
