// lib/stripe/webhook.ts — Bubaly Money webhook handling.
//
// Two jobs:
//   1) Idempotency — every Stripe event id is recorded before processing so a
//      retried delivery is a no-op (recordEvent returns false on duplicate).
//   2) Real-time card authorization — when Stripe asks "approve this purchase?",
//      we decide synchronously against the child's SPEND balance in the immutable
//      ledger and approve/decline. Capture later posts the debit.
//
// All money effects live in wallet_transactions; this module only orchestrates.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { childSpendableCents, debitCardSpend } from '@/lib/wallet/server';

type DB = SupabaseClient<Database>;

/**
 * Record the event for idempotency. Returns true if this is the first time we've
 * seen it (caller should process), false if it's a duplicate (caller should skip).
 */
export async function recordEvent(supabase: DB, event: Stripe.Event): Promise<boolean> {
  const { error } = await supabase.from('stripe_webhook_events').insert({
    stripe_event_id: event.id, type: event.type,
    payload_summary: { account: (event as { account?: string }).account ?? null, created: event.created },
  });
  // Unique-violation (23505) → already processed.
  if (error) return false;
  return true;
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
 * Handle issuing_authorization.request — the real-time approve/decline. Responds
 * to Stripe via the approve/decline API within the webhook window.
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
    const spendable = await childSpendableCents(supabase, card.family_id, card.child_wallet_id);
    decision = decideAuthorization({
      isFrozen: card.is_frozen, cardStatus: card.status, blockedCategories: card.blocked_categories,
      spendableCents: spendable, amountCents: amount, merchantCategory,
    });
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
 * Handle issuing_transaction.created — the capture. Posts a debit to the ledger
 * so the child's spend balance reflects the real purchase. Idempotent.
 */
export async function handleTransactionCreated(
  supabase: DB, txn: Stripe.Issuing.Transaction,
): Promise<void> {
  const cardId = typeof txn.card === 'string' ? txn.card : txn.card?.id;
  const card = cardId ? await cardForAuthorization(supabase, cardId) : null;
  if (!card) return;
  // Stripe issuing transaction amounts are negative for spends.
  const spend = Math.abs(txn.amount ?? 0);
  if (spend <= 0) return;
  const merchant = txn.merchant_data?.name ?? 'Card purchase';
  await debitCardSpend(supabase, {
    familyId: card.family_id, childWalletId: card.child_wallet_id,
    amountCents: spend, description: merchant, stripeRef: txn.id,
  });
}
