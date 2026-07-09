// app/api/webhooks/money/route.ts — Bubaly Money (Issuing/Treasury/Connect) webhook.
//
// Separate from the billing webhook (/api/webhooks/stripe) so the two concerns
// have independent signing secrets. Signature is verified before anything else;
// every event is deduped via stripe_webhook_events. The authorization handler
// must respond fast (Stripe's real-time window), so this route does minimal work.
import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/server';
import { recordEvent, handleAuthorizationRequest, handleTransactionCreated } from '@/lib/stripe/webhook';
import { syncConnectedAccount } from '@/lib/stripe/connect';
import { handleMarketplacePayment } from '@/lib/marketplace/payment-webhook';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature') ?? '';
  const secret = process.env.STRIPE_MONEY_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secret) return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, secret);
  } catch {
    return NextResponse.json({ error: 'Webhook signature invalid' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const account = (event as { account?: string }).account;

  // Authorization requests are time-critical and must run even on retried events,
  // so they bypass the idempotency short-circuit (Stripe only sends .request once
  // but the response API is itself idempotent).
  if (event.type === 'issuing_authorization.request') {
    await handleAuthorizationRequest(supabase, event.data.object as Stripe.Issuing.Authorization, account);
    return NextResponse.json({ received: true });
  }

  // Everything else is deduped.
  const fresh = await recordEvent(supabase, event);
  if (!fresh) return NextResponse.json({ received: true, duplicate: true });

  try {
    switch (event.type) {
      case 'issuing_transaction.created':
        await handleTransactionCreated(supabase, event.data.object as Stripe.Issuing.Transaction);
        break;
      case 'account.updated': {
        const acct = event.data.object as Stripe.Account;
        const familyId = acct.metadata?.family_id;
        if (familyId) await syncConnectedAccount(supabase, familyId, acct.id);
        break;
      }
      // Marketplace checkout payments: confirm a pending order/payment (or cancel).
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled':
        await handleMarketplacePayment(supabase, event.data.object as Stripe.PaymentIntent, event.type);
        break;
      default:
        // Unhandled event types are acknowledged (and recorded) so Stripe stops retrying.
        break;
    }
  } catch (e) {
    await supabase.from('stripe_webhook_events')
      .update({ status: 'error', error: e instanceof Error ? e.message : String(e) })
      .eq('stripe_event_id', event.id);
    // Still 200 so Stripe doesn't hammer us; the error is logged for replay.
    console.error('[money webhook] handler error', event.type, e);
  }

  return NextResponse.json({ received: true });
}
