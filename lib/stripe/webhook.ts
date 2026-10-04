// lib/stripe/webhook.ts — Bubaly Money webhook handling.
//
// Two jobs:
//   1) Idempotency — every Stripe event id is recorded before processing so a
//      active claims are a no-op for concurrent deliveries; failed or abandoned
//      claims can be recovered with an ownership token.
//   2) Real-time card authorization — when Stripe asks "approve this purchase?",
//      we decide synchronously against the child's SPEND balance in the immutable
//      ledger and approve/decline. Capture later posts the debit.
//
// All money effects live in wallet_transactions; this module only orchestrates.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { getStripe } from '@/lib/stripe';
import { cardHoldRef, reserveCardAuth, releaseCardHold, releaseRequestHold, creditCardRefund, settleCardCapture, closeCardAuth } from '@/lib/wallet/server';

type DB = SupabaseClient<Database>;
const STALE_EVENT_MS = 10 * 60 * 1000;

/**
 * Record the event for idempotency, replay-safely (audit PAY-2). Inserts the id
 * with status 'processing'. Returns 'fresh' for the first delivery, a failed
 * delivery, or a stale abandoned claim.
 *
 * 'duplicate' means FINISHED — the event reached status 'processed' — and is the
 * only outcome a caller may acknowledge with a 2xx.
 *
 * 'in_flight' means someone else holds the claim and has not finished. That is
 * NOT the same thing, and conflating the two loses money: an event whose handler
 * threw, and whose markEventError call then also failed, stays 'processing'. The
 * provider's next retry — inside STALE_EVENT_MS, so not yet reclaimable — used to
 * be answered 200, at which point the provider considers the event delivered and
 * stops retrying. The transaction it carried is then never applied, and the row
 * sits in 'processing' with nothing left to reprocess it. A caller must answer
 * 'in_flight' with a non-2xx so the retry keeps coming: if the holder succeeds
 * the next one sees 'processed' and is acknowledged, and if the holder died the
 * claim goes stale and is reclaimed.
 */
export type StripeEventClaim = { outcome: 'fresh' | 'duplicate' | 'in_flight'; claimToken?: string };

export async function recordEvent(supabase: DB, event: Stripe.Event): Promise<StripeEventClaim> {
  const now = new Date().toISOString();
  const claimToken = randomUUID();
  const { error } = await supabase.from('stripe_webhook_events').insert({
    stripe_event_id: event.id, type: event.type, status: 'processing',
    payload_summary: { account: (event as { account?: string }).account ?? null, created: event.created },
    processing_started_at: now,
    claim_token: claimToken,
  });
  if (!error) return { outcome: 'fresh', claimToken };
  // A unique conflict means another delivery owns or previously owned the claim.
  if (error.code !== '23505') throw new Error('Stripe webhook event ledger unavailable');

  // Do not let concurrent deliveries process the same active claim. A failed
  // or stale claim is reclaimed with a conditional update so only one retry wins.
  const { data: prior, error: readError } = await supabase
    .from('stripe_webhook_events')
    .select('status, processing_started_at, claim_token, created_at')
    .eq('stripe_event_id', event.id)
    .maybeSingle();
  if (readError || !prior) throw new Error('Stripe webhook event ledger unavailable');
  if (prior.status === 'processed') return { outcome: 'duplicate' };

  if (prior.status === 'error') {
    const { data: claimed, error: claimError } = await supabase
      .from('stripe_webhook_events')
      .update({ status: 'processing', error: null, processing_started_at: now, claim_token: claimToken })
      .eq('stripe_event_id', event.id)
      .eq('status', 'error')
      .select('stripe_event_id')
      .maybeSingle();
    if (claimError) throw new Error('Stripe webhook event ledger unavailable');
    return claimed ? { outcome: 'fresh', claimToken } : { outcome: 'in_flight' };
  }

  if (prior.status === 'processing') {
    const startedAt = prior.processing_started_at ?? prior.created_at;
    const age = Date.now() - new Date(startedAt).getTime();
    if (Number.isFinite(age) && age >= STALE_EVENT_MS) {
      let claim = supabase
        .from('stripe_webhook_events')
        .update({ status: 'processing', error: null, processing_started_at: now, claim_token: claimToken })
        .eq('stripe_event_id', event.id)
        .eq('status', 'processing');
      claim = prior.processing_started_at
        ? claim.eq('processing_started_at', prior.processing_started_at)
        : claim.is('processing_started_at', null);
      claim = prior.claim_token
        ? claim.eq('claim_token', prior.claim_token)
        : claim.is('claim_token', null);
      const { data: reclaimed, error: reclaimError } = await claim
        .select('stripe_event_id')
        .maybeSingle();
      if (reclaimError) throw new Error('Stripe webhook event ledger unavailable');
      return reclaimed ? { outcome: 'fresh', claimToken } : { outcome: 'in_flight' };
    }
  }

  return { outcome: 'in_flight' };
}

/** Mark an event as fully processed (so future deliveries short-circuit). */
export async function markEventProcessed(supabase: DB, eventId: string, claimToken: string): Promise<void> {
  const { data, error } = await supabase.from('stripe_webhook_events')
    .update({ status: 'processed', error: null, processing_started_at: null, claim_token: null })
    .eq('stripe_event_id', eventId).eq('claim_token', claimToken)
    .select('stripe_event_id').maybeSingle();
  if (error || !data) throw new Error('Stripe webhook event finalization failed');
}

/** Mark an event as errored (kept reprocessable; the route returns 500 to retry). */
export async function markEventError(supabase: DB, eventId: string, message: string, claimToken: string): Promise<void> {
  const { data, error } = await supabase.from('stripe_webhook_events')
    .update({ status: 'error', error: message.slice(0, 1000), processing_started_at: null, claim_token: null })
    .eq('stripe_event_id', eventId).eq('claim_token', claimToken)
    .select('stripe_event_id').maybeSingle();
  if (error || !data) throw new Error('Stripe webhook error state was not recorded');
}

/** Look up the card + family for an authorization, by Stripe card id. */
async function cardForAuthorization(supabase: DB, stripeCardId: string) {
  const { data, error } = await supabase
    .from('stripe_issuing_cards')
    .select('id, family_id, child_wallet_id, is_frozen, blocked_categories, status')
    .eq('stripe_card_id', stripeCardId)
    .maybeSingle();
  if (error) throw new Error('Stripe card mapping lookup failed');
  return data;
}

export type AuthDecision = { approve: boolean; reason: string };

/**
 * PURE decision: given the card state, the child's spendable balance and the
 * requested amount/category, decide approve/decline. Unit-tested separately.
 */
export function decideAuthorization(input: {
  isFrozen: boolean; cardStatus: string; blockedCategories: string[];
  spendableCents: number; amountCents: number; merchantCategory: string | null;
}): AuthDecision {
  if (input.cardStatus !== 'active') return { approve: false, reason: 'card_inactive' };
  if (input.isFrozen) return { approve: false, reason: 'card_frozen' };
  if (input.merchantCategory && input.blockedCategories.includes(input.merchantCategory)) {
    return { approve: false, reason: 'blocked_category' };
  }
  if (input.amountCents > input.spendableCents) return { approve: false, reason: 'insufficient_spend_balance' };
  return { approve: true, reason: 'approved' };
}

/**
 * PURE card-level pre-check (everything except balance). Returns a decline reason
 * or null when the card itself is fine and the balance must be reserved next.
 */
export function precheckCardAuthorization(input: {
  isFrozen: boolean; cardStatus: string; blockedCategories: string[]; merchantCategory: string | null;
}): AuthDecision | null {
  if (input.cardStatus !== 'active') return { approve: false, reason: 'card_inactive' };
  if (input.isFrozen) return { approve: false, reason: 'card_frozen' };
  if (input.merchantCategory && input.blockedCategories.includes(input.merchantCategory)) {
    return { approve: false, reason: 'blocked_category' };
  }
  return null;
}

/**
 * Handle issuing_authorization.request — the real-time approve/decline. Responds
 * to Stripe via the approve/decline API within the webhook window. The balance
 * decision goes through an ATOMIC reserve (audit PAY-1): the hold it writes stops
 * a concurrent authorization from approving against the same funds.
 */
export async function handleAuthorizationRequest(
  supabase: DB, auth: Stripe.Issuing.Authorization, stripeAccount: string | undefined,
): Promise<void> {
  const stripe = getStripe();
  const cardId = typeof auth.card === 'string' ? auth.card : auth.card?.id;
  const card = cardId ? await cardForAuthorization(supabase, cardId) : null;

  const amount = auth.pending_request?.amount ?? auth.amount ?? 0;
  // Requests Stripe had already decided; this one is next in its history.
  const priorRequests = auth.request_history?.length ?? 0;
  const holdRef = cardHoldRef(auth.id, priorRequests);
  const merchantCategory = auth.merchant_data?.category ?? null;
  const merchantName = auth.merchant_data?.name ?? null;

  let decision: AuthDecision;
  if (!card) {
    decision = { approve: false, reason: 'unknown_card' };
  } else {
    const pre = precheckCardAuthorization({
      isFrozen: card.is_frozen, cardStatus: card.status,
      blockedCategories: card.blocked_categories, merchantCategory,
    });
    if (pre) {
      decision = pre;
    } else {
      // A merchant raising an authorization it already holds sends another
      // request for the same id, asking for the increase; it is held under a
      // key of its own so it is balance-checked like the first (cardHoldRef).
      const reserved = await reserveCardAuth(supabase, {
        familyId: card.family_id, childWalletId: card.child_wallet_id, amountCents: amount,
        holdRef, description: merchantName ?? 'Card hold',
      });
      decision = reserved ? { approve: true, reason: 'approved' } : { approve: false, reason: 'insufficient_spend_balance' };
    }
  }

  // Tell Stripe. (On connected accounts, pass the stripeAccount header.)
  const opts = stripeAccount ? { stripeAccount } : undefined;
  try {
    if (decision.approve) await stripe.issuing.authorizations.approve(auth.id, {}, opts);
    else await stripe.issuing.authorizations.decline(auth.id, {}, opts);
  } catch (e) {
    console.error('[money] authorization response failed', e);
    // An approval that failed came after a hold was reserved for it.
    if (decision.approve) await releaseIfStripeDeclined(supabase, stripe, auth, priorRequests, holdRef, amount, opts);
    throw new Error('Stripe authorization response failed');
  }

  // Audit row. Best-effort on purpose and it must stay that way: Stripe has
  // already been told to approve or decline, and that is final. Throwing here
  // would answer the webhook non-2xx, Stripe would redeliver, and the retry
  // would try to decide an authorization that is already decided. So a failed
  // row may not fail the handler.
  //
  // What it may not do is fail in silence, which is what discarding the result
  // did. The insert RESOLVES with { data, error } rather than throwing, so
  // nothing here ever knew. And the row is read: the admin Stripe page lists the
  // last twenty outcomes with their decline reasons, and lib/ai/context/policy
  // exposes the table to the assistant as "card authorisations". A parent asking
  // why their child's card was declined is answered from rows that quietly may
  // not exist.
  if (card) {
    const { error: auditError } = await supabase.from('stripe_authorizations').insert({
      family_id: card.family_id, card_id: card.id, child_wallet_id: card.child_wallet_id,
      stripe_authorization_id: auth.id, amount_cents: amount,
      merchant_name: merchantName, merchant_category: merchantCategory,
      outcome: decision.approve ? 'approved' : 'declined',
      decline_reason: decision.approve ? null : decision.reason,
    });
    if (auditError) {
      console.error('[money] card authorization was decided but not recorded',
        { authorizationId: auth.id, outcome: decision.approve ? 'approved' : 'declined' }, auditError);
    }
  }
}

/** An authorization Stripe will not capture any further. */
const TERMINAL_AUTHORIZATION = ['reversed', 'expired', 'closed'];

/**
 * Whether Stripe declined this request in a way that holds nothing that can
 * still be captured. Not `network_fallback`: Stripe declined but the card
 * network decided, and when it approved, Stripe's docs say to treat it as
 * approved — it may still be captured. Such a hold stays while the
 * authorization is open and is released by its close like any other, so the
 * wait is bounded.
 */
function declinedForGood(entry: Stripe.Issuing.Authorization['request_history'][number]): boolean {
  return entry.approved === false && entry.reason !== 'network_fallback';
}

/**
 * Our approve call failed after this request's hold was reserved. Most often it
 * came after Stripe's 2-second window, and Stripe decided by the account's
 * timeout setting. Ask Stripe what it decided, because the authorization's own
 * `.created` may already have been handled before the hold committed, so
 * nothing else would release it:
 *   - the authorization is over (closed, reversed, expired): settle and release
 *     exactly as its own event does (handleAuthorizationUpdated);
 *   - this request (the next entry in its `request_history`, matched by the
 *     amount it asked for) was declined for good: release this request's hold
 *     only, so an increase never frees the purchase it raised.
 * Approved by the timeout setting, undecided, not recognisably this request, or
 * unknown because Stripe cannot be asked: the hold stays, for the
 * authorization's own events to settle. Money held, never money freed. Nothing
 * here may replace the caller's error.
 */
async function releaseIfStripeDeclined(
  supabase: DB, stripe: ReturnType<typeof getStripe>, auth: Stripe.Issuing.Authorization,
  priorRequests: number, holdRef: string, amount: number, opts: Stripe.RequestOptions | undefined,
): Promise<void> {
  let current: Stripe.Issuing.Authorization;
  try {
    current = await stripe.issuing.authorizations.retrieve(auth.id, {}, opts);
  } catch (e) {
    console.error('[money] could not ask Stripe how it decided; the hold stays', { authorizationId: auth.id, holdRef }, e);
    return;
  }
  try {
    if (TERMINAL_AUTHORIZATION.includes(current.status)) {
      await handleAuthorizationUpdated(supabase, current);
      return;
    }
    const decided = current.request_history?.[priorRequests];
    if (!decided || !declinedForGood(decided) || decided.amount !== amount) return;
    if (await releaseRequestHold(supabase, holdRef, amount) > 0) {
      console.warn('[money] Stripe declined a request we had reserved for; its hold is released',
        { authorizationId: auth.id, holdRef, reason: decided.reason });
    }
  } catch (e) {
    console.error('[money] Stripe declined a request we had reserved for, and its hold could not be released',
      { authorizationId: auth.id, holdRef }, e);
  }
}

/**
 * Handle issuing_transaction.created — a capture or a refund. A capture posts the
 * real debit (keyed by the transaction id, idempotent) and releases the
 * authorization hold reserved at approval, so the two never double-count; a
 * refund posts the credit back to Spend, keyed the same way, and leaves any hold
 * to its capture. Idempotent.
 */
export async function handleTransactionCreated(
  supabase: DB, txn: Stripe.Issuing.Transaction,
): Promise<void> {
  const cardId = typeof txn.card === 'string' ? txn.card : txn.card?.id;
  const card = cardId ? await cardForAuthorization(supabase, cardId) : null;
  if (!card) throw new Error('Stripe card mapping not found');
  const authId = typeof txn.authorization === 'string' ? txn.authorization : txn.authorization?.id ?? null;
  // `amount` is what the transaction does to the balance (stripe-node's
  // Issuing.Transaction: "reflected in your balance"): negative for a capture,
  // positive for a refund. Its absolute value used to be debited either way, so
  // a merchant refund took the money out a second time instead of giving it
  // back — a $20 purchase refunded in full left the child $40 down.
  const amount = Math.trunc(txn.amount ?? 0);
  if (amount < 0) {
    // The debit and the hold it draws down move together: the hold keeps what
    // this capture did not take, for a later capture or the authorization's close.
    // Only a CAPTURE draws a hold down. A refund with a negative amount (a refund
    // reversed) is money out, but it is not the authorization being spent, and
    // Stripe's link from a refund to an authorization is not exact.
    const merchant = txn.merchant_data?.name ?? 'Card purchase';
    const debit = await settleCardCapture(supabase, {
      familyId: card.family_id, childWalletId: card.child_wallet_id,
      amountCents: -amount, description: merchant, stripeRef: txn.id,
      authorizationId: txn.type === 'capture' ? authId : null,
    });
    if (!debit.ok) throw new Error(debit.error ?? 'Card spend persistence failed');
  } else if (amount > 0) {
    // A refund leaves the purchase's hold alone. Only the capture replaces it
    // (or issuing_authorization.updated, when the authorization closes). Stripe
    // does not promise event order, and a refund processed before its capture
    // used to cancel the hold as well as credit the refund — the held $20 and
    // the refunded $20 both became spendable, and the late capture overdrew.
    const merchant = txn.merchant_data?.name ?? 'Card refund';
    const refund = await creditCardRefund(supabase, {
      familyId: card.family_id, childWalletId: card.child_wallet_id,
      amountCents: amount, description: merchant, stripeRef: txn.id, authorizationId: authId,
    });
    if (!refund.ok) throw new Error(refund.error ?? 'Card refund persistence failed');
  }
}

/**
 * PURE: the mirror row a Stripe card implies. Separated from the write so the
 * mapping is testable without a database or a Stripe account.
 *
 * `is_frozen` is derived rather than mirrored: Stripe has three statuses and the
 * product has a boolean, and every status that is not `active` means the card
 * cannot spend. Reading it as `status === 'inactive'` would leave a CANCELED
 * card displayed as spendable, which is the failure this whole reconciler
 * exists to prevent.
 */
export function cardMirrorFromStripe(card: Stripe.Issuing.Card): {
  status: 'active' | 'inactive' | 'canceled';
  is_frozen: boolean;
  spend_limit_cents: number | null;
  spend_window: string;
  blocked_categories: string[];
} {
  const limit = card.spending_controls?.spending_limits?.[0] ?? null;
  return {
    status: card.status,
    is_frozen: card.status !== 'active',
    // No limit at Stripe is no limit here. `?? null` rather than `|| null` so a
    // deliberate zero-amount limit is not silently read as "unlimited".
    spend_limit_cents: limit ? limit.amount : null,
    spend_window: limit?.interval ?? 'per_authorization',
    blocked_categories: (card.spending_controls?.blocked_categories ?? []) as string[],
  };
}

/**
 * Handle issuing_card.updated / .created — reconcile our mirror of the card with
 * what Stripe actually holds.
 *
 * lib/stripe/issuing.ts changes a card in two steps: the Stripe update, which is
 * awaited and whose failure reaches the caller, and then the local mirror write,
 * whose result was discarded. Nothing reconciled the two, because this event was
 * not handled — so a refused mirror write left /wallet showing a spend limit the
 * card no longer had, or a freeze state it no longer had, permanently, while the
 * toast the parent had just seen said otherwise.
 *
 * Stripe is the authority for card state: it is what actually declines a
 * purchase. This makes that true of our copy too, on every change, whatever
 * caused it — including a change made in the Stripe dashboard, which the product
 * previously could not see at all.
 *
 * Idempotent: the same event applied twice writes the same row. A card we do not
 * know about is not an error — a family may have cards this deployment never
 * issued — so it is logged and skipped rather than thrown, which would make
 * Stripe retry an event that can never succeed.
 */
export async function handleIssuingCardUpdated(supabase: DB, card: Stripe.Issuing.Card): Promise<void> {
  const { data: existing, error: lookupError } = await supabase
    .from('stripe_issuing_cards')
    .select('id')
    .eq('stripe_card_id', card.id)
    .maybeSingle();
  // A failed LOOKUP is not an absent card, and the difference decides whether
  // Stripe retries. Throwing here is right: the event is still applicable.
  if (lookupError) throw new Error('Stripe card mapping lookup failed');
  if (!existing) {
    console.warn('[money] issuing card event for a card this deployment does not mirror', { stripeCardId: card.id });
    return;
  }

  // Rows deliberately not checked: `existing` was read just above, so zero rows
  // means the mirror row was deleted in between — there is nothing left to
  // mirror, and throwing would have Stripe retry an event nothing can apply.
  // Audit C1-S9-64.
  const { error } = await supabase
    .from('stripe_issuing_cards')
    .update(cardMirrorFromStripe(card))
    .eq('id', existing.id);
  // Reported, not swallowed — this handler exists BECAUSE a discarded write
  // error left the mirror wrong. Throwing returns 500 and Stripe retries, which
  // is exactly what a reconciler should do when it could not reconcile.
  if (error) throw new Error('Stripe card mirror update failed');
}

/**
 * Handle issuing_authorization.updated, and .created — when an authorization is
 * closed, reversed or expired, release what is left of its hold. Stripe sends
 * `.created` for every authorization; for one it decided itself (our answer
 * came too late) it is the only notice, and one it declined arrives already
 * closed and is released here like any other.
 *
 * First, whatever the status, the hold of each request Stripe declined for good
 * is released by its key and amount (an increase declined while the
 * authorization stays open). A `network_fallback` decline is not one of those:
 * its hold waits for the close.
 *
 * Its captures are settled FIRST. Stripe closes an authorization when it is
 * captured and does not order this event before issuing_transaction.created, so
 * releasing the hold on its own made the held money spendable again before the
 * capture debited it: a second purchase approved in that gap overdrew Spend. The
 * authorization carries its transactions, and settling one is idempotent on its
 * id, so whichever event arrives first posts the capture and the other changes
 * nothing. Only captures are settled here; every other transaction posts through
 * its own event and never touches a hold.
 *
 * `expired` is released as it always was, although Stripe allows a merchant to
 * capture an expired authorization late; such a capture is debited when it
 * arrives, with no hold left to draw down.
 */
export async function handleAuthorizationUpdated(
  supabase: DB, auth: Stripe.Issuing.Authorization,
): Promise<void> {
  // A request Stripe declined holds nothing it can capture, whatever the
  // authorization's status: release its hold by its key now. An increase
  // declined on an authorization still pending (by Stripe's timeout, or after
  // our approve call failed early) would otherwise wait for the close.
  const history = auth.request_history ?? [];
  for (let i = 0; i < history.length; i++) {
    if (declinedForGood(history[i])) await releaseRequestHold(supabase, cardHoldRef(auth.id, i), history[i].amount);
  }
  if (!TERMINAL_AUTHORIZATION.includes(auth.status)) return;
  const cardId = typeof auth.card === 'string' ? auth.card : auth.card?.id;
  const card = cardId ? await cardForAuthorization(supabase, cardId) : null;
  // Each request it had (the first, and any increase) may hold money.
  const requests = Math.max(history.length, 1);
  // No card mirror means no hold of ours to settle against; release each request's hold by its key.
  if (!card) { await releaseCardHold(supabase, auth.id, requests); return; }
  for (const txn of auth.transactions ?? []) {
    const amount = Math.trunc(txn.amount ?? 0);
    if (txn.type !== 'capture' || amount >= 0) continue;
    const settled = await settleCardCapture(supabase, {
      familyId: card.family_id, childWalletId: card.child_wallet_id, amountCents: -amount,
      description: txn.merchant_data?.name ?? auth.merchant_data?.name ?? 'Card purchase',
      stripeRef: txn.id, authorizationId: auth.id,
    });
    // A capture that could not be posted keeps the hold: Stripe retries the event.
    if (!settled.ok) throw new Error(settled.error ?? 'Card spend persistence failed');
  }
  await closeCardAuth(supabase, { familyId: card.family_id, childWalletId: card.child_wallet_id, authorizationId: auth.id, requests });
}
