// lib/marketplace/fee-policy.ts — the app's marketplace fee policy + the honest,
// gated wrapper that turns the pure fee engine (./fees) into an order breakdown.
//
// Design decision: the Bubaly marketplace is a *within-family* exchange, so it
// charges NO platform commission on a sale — the only platform take is the
// configurable Bubaly service fee, and only when Super Admin has enabled it
// (same gating the billing page uses for honest disclosure). When the fee is
// off, the buyer pays exactly the sale price and the seller receives all of it.
import { computeFees, type CommissionPolicy, type FeeBreakdown } from './fees';
import {
  resolveServiceFeeCents,
  serviceFeeEnabled,
  type ServiceFeeConfig,
} from '@/lib/stripe/service-fee';

/** No commission on intra-family sales; the service fee is the only take. */
export const MARKETPLACE_COMMISSION_POLICY: CommissionPolicy = {
  default: { kind: 'flat', cents: 0 },
};

/** Resolve the service fee to actually charge on a marketplace order (0 unless enabled). */
export function marketplaceServiceFeeCents(settings: ServiceFeeConfig): number {
  return serviceFeeEnabled(settings) ? resolveServiceFeeCents(settings) : 0;
}

/**
 * The transparent fee breakdown for one marketplace order — buyer total,
 * seller net, and the labeled line items — with the service fee applied only
 * when it is configured + enabled. `serviceFeeCents` is pre-resolved by the
 * caller (via `marketplaceServiceFeeCents`) so this stays pure/testable.
 */
export function orderFeeBreakdown(
  amountCents: number,
  serviceFeeCents = 0,
): FeeBreakdown {
  return computeFees({
    subtotalCents: amountCents,
    policy: MARKETPLACE_COMMISSION_POLICY,
    serviceFeeCents,
    // No card is charged for a marketplace order: nothing under lib/stripe or
    // app/api takes payment for one. The engine's default 2.9% + 30¢ was netted
    // out of the service fee anyway, so the seller read "Bubaly takes $0.00"
    // beside the buyer's "$0.90 service fee" on the same $20 order. Until a
    // payment path exists, there is no processing fee to allocate, and what the
    // buyer pays less what the seller receives is what the page says Bubaly takes.
    stripePercentBps: 0,
    stripeFixedCents: 0,
  });
}
