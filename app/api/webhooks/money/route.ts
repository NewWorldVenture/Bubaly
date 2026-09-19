// app/api/webhooks/money/route.ts — Bubaly Money (Issuing/Treasury/Connect) webhook.
//
// Separate from the billing webhook (/api/webhooks/stripe) so the two concerns
// have independent signing secrets. Signature is verified before anything else;
// every event is deduped via stripe_webhook_events. The authorization handler
// must respond fast (Stripe's real-time window), so this route does minimal work.
import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/server';
import {
  recordEvent, markEventProcessed, markEventError,
  handleAuthorizationRequest, handleTransactionCreated, handleAuthorizationUpdated,
  handleIssuingCardUpdated,
} from '@/lib/stripe/webhook';
import { syncConnectedAccount } from '@/lib/stripe/connect';
import { readBoundedRequestText } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
const MAX_WEBHOOK_BODY_BYTES = 256_000;

/**
 * The event types this endpoint actually handles.
 *
 * It matters that this is checked BEFORE the ledger claim. `stripe_webhook_events`
 * is shared with the billing webhook and its uniqueness is `stripe_event_id`
 * alone — there is no column recording which endpoint claimed an event. So
 * marking an unhandled type `processed` here did not merely ignore it: it
 * CLAIMED it, and the billing endpoint then saw `duplicate` and returned 200
 * having done no work. Both endpoints answer 2xx, Stripe never retries, nothing
 * logs an error, and a subscription event is dropped for good.
 *
 * That needs the documented fallback configuration to be reachable
 * (`STRIPE_MONEY_WEBHOOK_SECRET` unset, so a billing-signed event verifies
 * here) — a misconfiguration. The finding is not the misconfiguration, it is
 * the system's response to it. Acknowledging what we cannot handle and
 * recording it as done are two different decisions, and the `default` branch
 * made them as one. Audit C1-S4-01.
 */
const HANDLED_EVENT_TYPES = new Set<string>([
  'issuing_authorization.request',
  'issuing_authorization.updated',
  'issuing_transaction.created',
  'issuing_card.created',
  'issuing_card.updated',
  'account.updated',
]);

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const boundedBody = await readBoundedRequestText(req, MAX_WEBHOOK_BODY_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Payload too large' : 'Unable to read payload' }, { status: boundedBody.reason === 'too_large' ? 413 : 400 });
  const body = boundedBody.text;
  const sig = req.headers.get('stripe-signature') ?? '';
  const secret = process.env.STRIPE_MONEY_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secret) return NextResponse.json({ error: t('money.webhookNotConfigured') }, { status: 503 });

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, secret);
  } catch {
    return NextResponse.json({ error: t('money.webhookSignatureInvalid') }, { status: 400 });
  }

  const supabase = createServiceClient();
  const account = (event as { account?: string }).account;

  // Acknowledged, deliberately NOT claimed: 200 stops Stripe retrying an
  // endpoint that does not handle this type, while leaving the event untouched
  // in a ledger this route shares with the billing webhook. Audit C1-S4-01.
  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    return NextResponse.json({ received: true, handled: false });
  }

  // Authorization requests are time-critical and must run even on retried events,
  // so they bypass the idempotency short-circuit (Stripe only sends .request once
  // but the response API is itself idempotent).
  if (event.type === 'issuing_authorization.request') {
    await handleAuthorizationRequest(supabase, event.data.object as Stripe.Issuing.Authorization, account);
    return NextResponse.json({ received: true });
  }

  // Everything else is deduped. Only a FINISHED event is acknowledged; one that
  // another delivery still holds gets a 409 so Stripe keeps retrying, because an
  // unfinished claim is not a completed one — see recordEvent.
  let claimToken = '';
  try {
    const claim = await recordEvent(supabase, event);
    if (claim.outcome === 'duplicate') return NextResponse.json({ received: true, duplicate: true });
    if (claim.outcome === 'in_flight') return NextResponse.json({ error: 'event_in_flight' }, { status: 409 });
    claimToken = claim.claimToken ?? '';
  } catch {
    return NextResponse.json({ error: t('money.webhookStorageUnavailable') }, { status: 503 });
  }
  if (!claimToken) return NextResponse.json({ error: t('money.webhookStorageUnavailable') }, { status: 503 });

  try {
    switch (event.type) {
      case 'issuing_transaction.created':
        await handleTransactionCreated(supabase, event.data.object as Stripe.Issuing.Transaction);
        break;
      case 'issuing_authorization.updated':
        await handleAuthorizationUpdated(supabase, event.data.object as Stripe.Issuing.Authorization);
        break;
      // The card's own state. lib/stripe/issuing.ts writes our mirror after the
      // Stripe update and used to discard that write's result, and nothing
      // reconciled the two because this event fell through to `default` — so a
      // refused mirror write left /wallet showing a limit or a freeze state the
      // card no longer had, permanently. `.created` is here too: a card issued
      // while the mirror insert failed is the same divergence on its first day.
      case 'issuing_card.created':
      case 'issuing_card.updated':
        await handleIssuingCardUpdated(supabase, event.data.object as Stripe.Issuing.Card);
        break;
      case 'account.updated': {
        const acct = event.data.object as Stripe.Account;
        const familyId = acct.metadata?.family_id;
        if (familyId) await syncConnectedAccount(supabase, familyId, acct.id);
        break;
      }
      default:
        // Unreachable: HANDLED_EVENT_TYPES is checked before the claim above,
        // and every member of it has a case here. Kept so adding a type to that
        // set without a handler is a no-op rather than a crash — but it no
        // longer marks anything processed, which is what made it dangerous.
        break;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The handler failure is the one an operator needs, so log it even when
    // recording the error state fails. Unguarded, markEventError's own throw
    // escaped this block and took the money error with it, leaving only the
    // secondary failure in the logs.
    console.error('[money webhook] handler error', event.type, e);
    try {
      await markEventError(supabase, event.id, message, claimToken);
    } catch (markError) {
      console.error('[money webhook] failed to record handler error', markError);
    }
    // Return 500 so Stripe retries; recordEvent keeps errored events reprocessable
    // and the money handlers are idempotent, so the retry settles correctly.
    return NextResponse.json({ error: 'handler_failed' }, { status: 500 });
  }

  try {
    await markEventProcessed(supabase, event.id, claimToken);
  } catch (err) {
    // The side effects landed but the claim did not close. Answering 2xx here
    // would strand the row in 'processing'; a non-2xx lets the retry settle it.
    console.error('[money webhook] failed to finalize event', err);
    return NextResponse.json({ error: t('money.webhookStorageUnavailable') }, { status: 503 });
  }
  return NextResponse.json({ received: true });
}
