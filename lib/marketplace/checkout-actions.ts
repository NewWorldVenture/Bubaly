'use server';

// lib/marketplace/checkout-actions.ts — the checkout server action. Creates a
// PENDING marketplace order + payment from a SERVER-recomputed fee quote (never
// trusting client amounts). It does NOT fake a charge: the order/payment start
// 'pending' and a later Stripe step (§1a) confirms them via webhook. Honors the
// spec's "never mark paid unless the provider confirms".

import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { getStripe } from '@/lib/stripe';
import { loadCheckoutQuote, orderInsertFromQuote } from './server';
import type { PromoOverride } from './fees';

export interface CreateOrderInput {
  listingId: string;
  mode?: string;
  fulfillment?: 'pickup' | 'shipping' | 'digital' | null;
  promo?: PromoOverride | null;
  depositCents?: number;
  taxCents?: number;
}

export type CreateOrderResult =
  | { ok: true; orderId: string; totalCents: number }
  | { ok: false; error: string };

/**
 * Create a pending order + payment for a listing. Recomputes the fee quote on the
 * server, resolves the seller from the listing, inserts the order, then a pending
 * payment linked to it. RLS keeps it family-scoped.
 */
export async function createMarketplaceOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const buyerUserId = ctx.user.id;
  const buyerMemberId = ctx.active.member?.id ?? null;

  const sb = await createServer();

  const quote = await loadCheckoutQuote(sb, {
    familyId,
    listingId: input.listingId,
    promo: input.promo,
    depositCents: input.depositCents,
    taxCents: input.taxCents,
  });
  if (!quote) return { ok: false, error: 'That listing is no longer available.' };

  const { data: seller } = await sb
    .from('marketplace_listings')
    .select('member_id, created_by')
    .eq('id', input.listingId)
    .maybeSingle();

  const order = orderInsertFromQuote(quote, {
    familyId,
    buyerUserId,
    buyerMemberId,
    sellerUserId: seller?.created_by ?? null,
    sellerMemberId: seller?.member_id ?? null,
    mode: input.mode,
    fulfillment: input.fulfillment ?? null,
    createdBy: buyerUserId,
  });

  const { data: created, error: orderErr } = await sb
    .from('marketplace_orders')
    .insert(order)
    .select('id')
    .single();
  if (orderErr || !created) {
    console.error('[marketplace] createOrder: order insert failed', orderErr);
    return { ok: false, error: 'Could not start checkout. Please try again.' };
  }

  const { error: payErr } = await sb.from('marketplace_payments').insert({
    family_id: familyId,
    order_id: created.id,
    buyer_user_id: buyerUserId,
    seller_user_id: seller?.created_by ?? null,
    amount_cents: quote.breakdown.buyerTotalCents,
    fee_cents: quote.breakdown.marketplaceFeeCents + quote.breakdown.serviceFeeCents,
    currency: quote.listing.currency,
    status: 'pending', // never 'succeeded' until Stripe confirms via webhook
    created_by: buyerUserId,
  });
  if (payErr) console.error('[marketplace] createOrder: payment insert failed', payErr);

  return { ok: true, orderId: created.id, totalCents: quote.breakdown.buyerTotalCents };
}

export type PaymentIntentResult =
  | { ok: true; clientSecret: string; paymentIntentId: string }
  | { ok: false; setupRequired: true }
  | { ok: false; error: string };

/**
 * Create a Stripe PaymentIntent for a pending order and stamp its id on the
 * payment row so the webhook can confirm it. When Stripe isn't configured this
 * returns `setupRequired` instead of faking a charge (spec: "if payment provider
 * is not configured, create setup states … without faking payments"). The
 * payment stays 'pending' until payment_intent.succeeded arrives.
 */
export async function createPaymentIntentForOrder(orderId: string): Promise<PaymentIntentResult> {
  if (!process.env.STRIPE_SECRET_KEY) return { ok: false, setupRequired: true };

  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const sb = await createServer();

  const { data: payment } = await sb
    .from('marketplace_payments')
    .select('id, amount_cents, currency, status, stripe_payment_intent_id')
    .eq('order_id', orderId)
    .eq('family_id', familyId)
    .maybeSingle();
  if (!payment) return { ok: false, error: 'No payment found for that order.' };
  if (payment.status === 'succeeded') return { ok: false, error: 'This order is already paid.' };
  if ((payment.amount_cents ?? 0) <= 0) return { ok: false, error: 'Nothing to charge for that order.' };

  try {
    const intent = await getStripe().paymentIntents.create({
      amount: payment.amount_cents,
      currency: (payment.currency || 'usd').toLowerCase(),
      automatic_payment_methods: { enabled: true },
      metadata: { marketplace_order_id: orderId, marketplace_payment_id: payment.id, family_id: familyId },
    });
    await sb.from('marketplace_payments')
      .update({ stripe_payment_intent_id: intent.id, status: 'processing' })
      .eq('id', payment.id);
    if (!intent.client_secret) return { ok: false, error: 'Could not start payment.' };
    return { ok: true, clientSecret: intent.client_secret, paymentIntentId: intent.id };
  } catch (e) {
    console.error('[marketplace] createPaymentIntent failed', e);
    return { ok: false, error: 'Could not start payment. Please try again.' };
  }
}
