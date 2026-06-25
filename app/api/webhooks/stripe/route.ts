import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/server';
import { withStripeTables } from '@/lib/supabase/stripe-tables';
import { markReferralConverted } from '@/lib/referrals/server';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import { creditChildWallet } from '@/lib/wallet/server';
import type { WalletTxnType, WalletTxnStatus } from '@/lib/database.types';
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
      cancel_at_period_end: sub.cancel_at_period_end ?? false,
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
  const db = withStripeTables(supabase);

  // Idempotent: log every event (deduped by event_id) so replays are safe.
  await db.from('stripe_webhook_events').upsert(
    {
      event_id: event.id,
      type: event.type,
      livemode: event.livemode,
      api_version: event.api_version ?? null,
      family_id: (event.data.object as { metadata?: { family_id?: string } })?.metadata?.family_id ?? null,
      status: 'pending',
      raw_payload: event as unknown as Record<string, unknown>,
    },
    { onConflict: 'event_id', ignoreDuplicates: true },
  ).catch(() => { /* non-fatal — table may not exist yet */ });

  try {
    await handleEvent(supabase, event);
    await db.from('stripe_webhook_events')
      .update({ status: 'processed', processed_at: new Date().toISOString() })
      .eq('event_id', event.id)

  } catch (err) {
    await db.from('stripe_webhook_events')
      .update({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
      .eq('event_id', event.id)
      
    throw err;
  }

  return NextResponse.json({ received: true });
}

async function handleEvent(supabase: ReturnType<typeof createServiceClient>, event: Stripe.Event) {
  const db = withStripeTables(supabase);

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      await upsertSubscription(supabase, event.data.object as Stripe.Subscription);
      break;
    }

    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Response<Stripe.Checkout.Session>;
      const familyId = session.metadata?.family_id;
      const sessionType = session.metadata?.type;

      // Update subscription billing_customer
      if (familyId && session.customer) {
        await supabase.from('billing_customers').upsert(
          { family_id: familyId, provider: 'stripe', customer_ref: String(session.customer) },
          { onConflict: 'family_id' },
        );
      }

      // Mark platform checkout_sessions (subscription) complete
      await supabase
        .from('checkout_sessions')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('session_id', session.id);

      // Bubaly Money: credit child wallet on gift or topup completion
      if (familyId && (sessionType === 'gift' || sessionType === 'topup')) {
        await handleMoneyCheckout(supabase, session, sessionType);
      }

      // Mark stripe_checkout_sessions complete
      await db
        .from('stripe_checkout_sessions')
        .update({
          status: 'complete',
          payment_intent_id: session.payment_intent ? String(session.payment_intent) : null,
          completed_at: new Date().toISOString(),
        })
        .eq('session_id', session.id);

      // Fire automation event (best-effort)
      try {
        const buyerEmail = session.customer_details?.email ?? session.customer_email ?? null;
        await fireAutomationEvent(supabase, {
          trigger: 'payment_completed',
          email: buyerEmail,
          name: session.customer_details?.name ?? null,
          subjectKey: eventSubjectKey('payment_completed', [session.id]),
          context: { familyId: familyId ?? null, sessionId: session.id },
        });
      } catch { /* non-fatal */ }
      break;
    }

    case 'account.updated': {
      const account = event.data.object as Stripe.Account;
      await db
        .from('stripe_connected_accounts')
        .update({
          charges_enabled: account.charges_enabled ?? false,
          payouts_enabled: account.payouts_enabled ?? false,
          details_submitted: account.details_submitted ?? false,
          status: account.charges_enabled ? 'active' : 'pending',
        })
        .eq('account_id', account.id);
      break;
    }

    case 'issuing_authorization.created': {
      // Log incoming authorizations (real-time decisions handled by /api/issuing/authorization)
      const auth = event.data.object as Stripe.Issuing.Authorization;
      const meta = auth.metadata ?? {};
      await db.from('stripe_authorizations').upsert(
        {
          authorization_id: auth.id,
          family_id: meta.family_id ?? null,
          card_id: auth.card.id,
          child_wallet_id: meta.child_wallet_id ?? null,
          status: auth.status as 'pending' | 'approved' | 'declined' | 'reversed' | 'closed',
          decision: auth.approved ? 'approved' : 'declined',
          amount_cents: auth.amount,
          currency: auth.currency,
          merchant_name: auth.merchant_data?.name ?? null,
          merchant_category: auth.merchant_data?.category ?? null,
          metadata: meta as Record<string, unknown>,
          authorized_at: new Date().toISOString(),
        },
        { onConflict: 'authorization_id' },
      );
      break;
    }

    case 'issuing_authorization.updated': {
      const auth = event.data.object as Stripe.Issuing.Authorization;
      await db
        .from('stripe_authorizations')
        .update({
          status: auth.status as 'pending' | 'approved' | 'declined' | 'reversed' | 'closed',
          decision: auth.approved ? 'approved' : 'declined',
        })
        .eq('authorization_id', auth.id);
      break;
    }
  }
}

async function handleMoneyCheckout(
  supabase: ReturnType<typeof createServiceClient>,
  session: Stripe.Response<Stripe.Checkout.Session>,
  type: 'gift' | 'topup',
) {
  const meta = session.metadata ?? {};
  const familyId = meta.family_id;
  const amountCents = parseInt(meta.amount_cents ?? '0', 10);

  if (!familyId || amountCents <= 0) return;

  if (type === 'gift') {
    const giftPaymentId = meta.gift_payment_id;
    if (!giftPaymentId) return;

    // Find the gift payment to get child_wallet_id
    const { data: gift } = await supabase
      .from('gift_payments')
      .select('id, child_wallet_id, status')
      .eq('id', giftPaymentId)
      .maybeSingle();

    if (!gift || (gift.status as string) === 'credited') return; // Idempotency guard

    await creditChildWallet(supabase, {
      familyId,
      childWalletId: gift.child_wallet_id ?? '',
      amountCents,
      type: 'gift' as unknown as WalletTxnType,
      description: `Gift from ${meta.giver_name || 'family'}${meta.message ? ` — "${meta.message}"` : ''}`,
      createdBy: null,
      relatedType: 'gift_payment',
      relatedId: giftPaymentId,
    });

    // Mark gift payment credited
    await supabase
      .from('gift_payments')
      .update({ status: 'credited' as unknown as WalletTxnStatus })
      .eq('id', giftPaymentId);

  } else if (type === 'topup') {
    const childWalletId = meta.child_wallet_id;
    if (!childWalletId) return;

    // Guard against double-credit using stripe session id as idempotency key
    const { count } = await supabase
      .from('wallet_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('related_type', 'stripe_checkout')
      .eq('related_id', session.id);

    if ((count ?? 0) > 0) return;

    await creditChildWallet(supabase, {
      familyId,
      childWalletId,
      amountCents,
      type: 'topup' as unknown as WalletTxnType,
      description: 'Parent wallet top-up',
      createdBy: null,
      relatedType: 'stripe_checkout',
      relatedId: session.id,
    });
  }
}
