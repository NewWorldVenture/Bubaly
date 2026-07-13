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
import {
  recordEvent, markEventProcessed, markEventError,
  handleAuthorizationRequest, handleTransactionCreated, handleAuthorizationUpdated,
} from '@/lib/stripe/webhook';
import { syncConnectedAccount } from '@/lib/stripe/connect';
import { readBoundedRequestText } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
const MAX_WEBHOOK_BODY_BYTES = 256_000;

export async function POST(req: NextRequest) {
  const boundedBody = await readBoundedRequestText(req, MAX_WEBHOOK_BODY_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Payload too large' : 'Unable to read payload' }, { status: boundedBody.reason === 'too_large' ? 413 : 400 });
  const body = boundedBody.text;
  const sig = req.headers.get('stripe-signature') ?? '';
  const secret = process.env.STRIPE_MONEY_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secret) return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });

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

  // Everything else is deduped. Failed or abandoned claims can be retried, while
  // an active concurrent delivery is acknowledged without repeating side effects.
  let claimToken = '';
  try {
    const claim = await recordEvent(supabase, event);
    if (claim.outcome === 'duplicate') return NextResponse.json({ received: true, duplicate: true });
    claimToken = claim.claimToken ?? '';
  } catch {
    return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });
  }
  if (!claimToken) return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });

  try {
    switch (event.type) {
      case 'issuing_transaction.created':
        await handleTransactionCreated(supabase, event.data.object as Stripe.Issuing.Transaction);
        break;
      case 'issuing_authorization.updated':
        await handleAuthorizationUpdated(supabase, event.data.object as Stripe.Issuing.Authorization);
        break;
      case 'account.updated': {
        const acct = event.data.object as Stripe.Account;
        const familyId = acct.metadata?.family_id;
        if (familyId) await syncConnectedAccount(supabase, familyId, acct.id);
        break;
      }
      default:
        // Unhandled event types are acknowledged (and marked processed) so Stripe stops retrying.
        break;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await markEventError(supabase, event.id, message, claimToken);
    console.error('[money webhook] handler error', event.type, e);
    // Return 500 so Stripe retries; recordEvent keeps errored events reprocessable
    // and the money handlers are idempotent, so the retry settles correctly.
    return NextResponse.json({ error: 'handler_failed' }, { status: 500 });
  }

  await markEventProcessed(supabase, event.id, claimToken);
  return NextResponse.json({ received: true });
}
