// lib/stripe/checkout.ts — Stripe Checkout session creation for Bubaly Money.
// Used for grandparent gifts, parent top-ups, and Plus subscription payments.
// Falls back gracefully when Stripe is not configured.

import { getStripe } from '@/lib/stripe';
import { computeFunding } from '@/lib/wallet/fees';
import type { WalletTier } from '@/lib/wallet/fees';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://bubaly.com';

export type CheckoutResult = {
  ok: boolean;
  url?: string;
  sessionId?: string;
  error?: string;
};

/** Create a Stripe Checkout session for a grandparent/relative gift. */
export async function createGiftCheckoutSession(params: {
  amountCents: number;
  childName: string;
  giverEmail?: string;
  giverName?: string;
  message?: string;
  giftPaymentId: string;
  familyId: string;
  tier: WalletTier;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<CheckoutResult> {
  try {
    const stripe = getStripe();
    const funding = computeFunding(params.amountCents, params.tier);
    const totalCents = funding.totalChargedCents;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: params.giverEmail,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Gift for ${params.childName}`,
              description: params.message
                ? `"${params.message}"`
                : `A gift to ${params.childName}'s Bubaly Wallet`,
            },
            unit_amount: totalCents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        type: 'gift',
        gift_payment_id: params.giftPaymentId,
        family_id: params.familyId,
        amount_cents: String(params.amountCents),
        giver_name: params.giverName ?? '',
        giver_email: params.giverEmail ?? '',
        message: params.message ?? '',
      },
      success_url: params.successUrl ?? `${APP_URL}/gift/success?session={CHECKOUT_SESSION_ID}`,
      cancel_url: params.cancelUrl ?? `${APP_URL}/gift/cancelled`,
      payment_intent_data: {
        description: `Bubaly gift for ${params.childName}`,
        statement_descriptor: 'BUBALY GIFT',
        metadata: {
          gift_payment_id: params.giftPaymentId,
          family_id: params.familyId,
          amount_for_child_cents: String(params.amountCents),
        },
      },
    });

    return { ok: true, url: session.url ?? undefined, sessionId: session.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create checkout session' };
  }
}

/** Create a Stripe Checkout session for a parent wallet top-up. */
export async function createTopupCheckoutSession(params: {
  amountCents: number;
  childName: string;
  familyId: string;
  childWalletId: string;
  customerId?: string;
  tier: WalletTier;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<CheckoutResult> {
  try {
    const stripe = getStripe();
    const funding = computeFunding(params.amountCents, params.tier);
    const totalCents = funding.totalChargedCents;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer: params.customerId,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Add funds — ${params.childName}`,
              description: `Deposit to ${params.childName}'s Bubaly Wallet (child receives $${(params.amountCents / 100).toFixed(2)})`,
            },
            unit_amount: totalCents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        type: 'topup',
        family_id: params.familyId,
        child_wallet_id: params.childWalletId,
        amount_cents: String(params.amountCents),
      },
      success_url: params.successUrl ?? `${APP_URL}/money?topup=success`,
      cancel_url: params.cancelUrl ?? `${APP_URL}/money`,
      payment_intent_data: {
        description: `Bubaly wallet top-up for ${params.childName}`,
        statement_descriptor: 'BUBALY TOPUP',
        metadata: {
          family_id: params.familyId,
          child_wallet_id: params.childWalletId,
          amount_for_child_cents: String(params.amountCents),
        },
      },
    });

    return { ok: true, url: session.url ?? undefined, sessionId: session.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create checkout session' };
  }
}

/** Retrieve a Checkout session (for webhook handling / confirmation). */
export async function retrieveCheckoutSession(sessionId: string) {
  const stripe = getStripe();
  return stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent', 'line_items'],
  });
}
