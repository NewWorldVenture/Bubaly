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
import { reserveCardAuth, releaseCardHold, debitCardSpend } from '@/lib/wallet/server';

type DB = SupabaseClient<Database>;
const STALE_EVENT_MS = 10 * 60 * 1000;

/**
 * Record the event for idempotency, replay-safely (audit PAY-2). Inserts the id
 * with status 'processing'. Returns 'fresh' for the first delivery, a failed
 * delivery, or a stale abandoned claim. An active concurrent delivery and a
 * fully 'processed' event both return 'duplicate'.
 */
export type StripeEventClaim = { outcome: 'fresh' | 'duplicate'; claimToken?: string };

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
    return claimed ? { outcome: 'fresh', claimToken } : { outcome: 'duplicate' };
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
      return reclaimed ? { outcome: 'fresh', claimToken } : { outcome: 'duplicate' };
    }
  }

  return { outcome: 'duplicate' };
}

/** Mark an event as fully processed (so future deliveries short-circuit). */
export async function markEventProcessed(supabase: DB, eventId: string, claimToken: string): Promise<void> {
  await supabase.from('stripe_webhook_events')
    .update({ status: 'processed', error: null, processing_started_at: null, claim_token: null })
    .eq('stripe_event_id', eventId).eq('claim_token', claimToken);
}

/** Mark an event as errored (kept reprocessable; the route returns 500 to retry). */
export async function markEventError(supabase: DB, eventId: string, message: string, claimToken: string): Promise<void> {
  await supabase.from('stripe_webhook_events')
    .update({ status: 'error', error: message.slice(0, 1000), processing_started_at: null, claim_token: null })
    .eq('stripe_event_id', eventId).eq('claim_token', claimToken);
}

/** Look up the card + family for an authorization, by Stripe card id. */
async function cardForAuthorization(supabase: DB, stripeCardId: string) {
  const { data } = await supabase
    .from('stripe_issuing_cards')
    .select('id, family_id, child_wallet_id, is_frozen, blocked_categories, status')
    .eq('stripe_card_id', stripeCardId)
    .maybeSingle();
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
      const reserved = await reserveCardAuth(supabase, {
        familyId: card.family_id, childWalletId: card.child_wallet_id,
        amountCents: amount, authId: auth.id, description: merchantName ?? 'Card hold',
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
  }

  // Audit row (best-effort).
  if (card) {
    await supabase.from('stripe_authorizations').insert({
      family_id: card.family_id, card_id: card.id, child_wallet_id: card.child_wallet_id,
      stripe_authorization_id: auth.id, amount_cents: amount,
      merchant_name: merchantName, merchant_category: merchantCategory,
      outcome: decision.approve ? 'approved' : 'declined',
      decline_reason: decision.approve ? null : decision.reason,
    });
  }
}

/**
 * Handle issuing_transaction.created — the capture. Posts the real debit (keyed
 * by the transaction id, idempotent) and releases the authorization hold that was
 * reserved at approval, so the two never double-count. Idempotent.
 */
export async function handleTransactionCreated(
  supabase: DB, txn: Stripe.Issuing.Transaction,
): Promise<void> {
  const cardId = typeof txn.card === 'string' ? txn.card : txn.card?.id;
  const card = cardId ? await cardForAuthorization(supabase, cardId) : null;
  if (!card) return;
  const authId = typeof txn.authorization === 'string' ? txn.authorization : txn.authorization?.id ?? null;
  // Stripe issuing transaction amounts are negative for spends.
  const spend = Math.abs(txn.amount ?? 0);
  if (spend > 0) {
    const merchant = txn.merchant_data?.name ?? 'Card purchase';
    await debitCardSpend(supabase, {
      familyId: card.family_id, childWalletId: card.child_wallet_id,
      amountCents: spend, description: merchant, stripeRef: txn.id,
    });
  }
  // The captured debit now represents the spend; drop the pending hold.
  if (authId) await releaseCardHold(supabase, authId);
}

/**
 * Handle issuing_authorization.updated — release the hold when an authorization
 * will no longer be captured (reversed / expired / closed). No-op if already
 * released by the capture path (only `processing` holds are touched).
 */
export async function handleAuthorizationUpdated(
  supabase: DB, auth: Stripe.Issuing.Authorization,
): Promise<void> {
  if (['reversed', 'expired', 'closed'].includes(auth.status)) {
    await releaseCardHold(supabase, auth.id);
  }
}
