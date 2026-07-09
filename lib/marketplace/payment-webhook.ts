// lib/marketplace/payment-webhook.ts — apply a confirmed Stripe payment outcome
// to a marketplace order. This is what makes "never mark paid unless the provider
// confirms" real: only a payment_intent.succeeded event flips the pending payment
// to succeeded and advances the order to sold; failures/cancellations cancel it.
// Event-level idempotency lives in lib/stripe/webhook.ts (recordEvent); this also
// no-ops if the payment is already in the target state, and guards the order move
// through the state machine.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type Stripe from 'stripe';
import { canOrderTransition, type OrderStatus } from './order-lifecycle';

type DB = SupabaseClient<Database>;

export type MarketplacePaymentStatus = 'succeeded' | 'failed' | 'canceled';

/** Map a Stripe payment_intent event type to our payment status, or null. */
export function paymentStatusFromEvent(eventType: string): MarketplacePaymentStatus | null {
  switch (eventType) {
    case 'payment_intent.succeeded': return 'succeeded';
    case 'payment_intent.payment_failed': return 'failed';
    case 'payment_intent.canceled': return 'canceled';
    default: return null;
  }
}

/** The order status a payment outcome should drive the order toward, or null. */
export function orderTargetForPayment(paymentStatus: MarketplacePaymentStatus): OrderStatus | null {
  switch (paymentStatus) {
    case 'succeeded': return 'sold';
    case 'failed':
    case 'canceled': return 'canceled';
  }
}

/**
 * Apply a payment_intent event to the marketplace payment + its order. No-ops if
 * the event isn't a payment_intent outcome, the payment row is unknown, or it's
 * already settled to the same status. The order only advances when the state
 * machine allows it.
 */
export async function handleMarketplacePayment(
  supabase: DB, intent: Pick<Stripe.PaymentIntent, 'id'>, eventType: string,
): Promise<void> {
  const status = paymentStatusFromEvent(eventType);
  if (!status) return;

  const { data: payment, error } = await supabase
    .from('marketplace_payments')
    .select('id, order_id, status')
    .eq('stripe_payment_intent_id', intent.id)
    .maybeSingle();
  if (error || !payment) return;
  if (payment.status === status) return; // idempotent — already applied

  await supabase.from('marketplace_payments').update({ status }).eq('id', payment.id);

  if (!payment.order_id) return;
  const target = orderTargetForPayment(status);
  if (!target) return;

  const { data: order } = await supabase
    .from('marketplace_orders')
    .select('status')
    .eq('id', payment.order_id)
    .maybeSingle();
  if (order && canOrderTransition(order.status as OrderStatus, target)) {
    await supabase.from('marketplace_orders').update({ status: target }).eq('id', payment.order_id);
  }
}
