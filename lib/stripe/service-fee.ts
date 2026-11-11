// lib/stripe/service-fee.ts — the Bubaly per-transaction service fee. Pure +
// tested. The amount is configurable in Super Admin → Stripe Setup; this module
// holds the default and the helpers that turn it into Stripe API shapes.

import FAMILY_PRICES from '@/lib/constants/family-prices.json';
import type { LocaleCode } from '@/lib/i18n/locales';
import { formatCents } from '@/lib/wallet/ledger';

/** Default Bubaly service fee added to transactions: $0.90. */
export const DEFAULT_SERVICE_FEE_CENTS = 90;

export type ServiceFeeConfig = {
  enabled?: boolean | null;
  service_fee_cents?: number | null;
  service_fee_price_id?: string | null;
} | null | undefined;

/** Resolve the configured fee (cents), falling back to the $0.90 default. */
export function resolveServiceFeeCents(settings: ServiceFeeConfig): number {
  const v = settings?.service_fee_cents;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : DEFAULT_SERVICE_FEE_CENTS;
}

/**
 * The fee as the READER writes money: 90 → "$0.90" for en-US, "0,90 $" for
 * de-DE. Its one caller is the checkout disclosure on /dashboard/billing, which
 * resolves the reader's locale with getLocaleContext(). The locale is required,
 * not defaulted, so a new caller cannot quietly print American money to everyone.
 *
 * The currency is the plan catalogue's: the fee rides the subscription's first
 * invoice (serviceFeeAddInvoiceItems below), and Stripe charges that line in
 * its subscription's currency. stripe_settings has no currency column.
 */
export function formatServiceFee(cents: number, locale: LocaleCode): string {
  return formatCents(Math.max(0, Math.trunc(cents)), FAMILY_PRICES.currency.toUpperCase(), locale);
}

/** True when the service fee should actually be applied to a charge. */
export function serviceFeeEnabled(settings: ServiceFeeConfig): boolean {
  return Boolean(settings?.enabled) && resolveServiceFeeCents(settings) > 0;
}

/**
 * The service fee as a one-time Price line: a charge on the subscription's
 * first invoice only, using a Price in the Bubaly account, so the fee is
 * collected to Bubaly without touching the recurring plan item (keeps webhook
 * plan-mapping correct). A subscription-mode Checkout Session takes it as an
 * extra `line_items` entry; `subscription_data.add_invoice_items` is not a
 * Checkout parameter (it belongs to the Subscriptions API) and Stripe refuses
 * a session that carries it. Returns `undefined` when the fee is off or no
 * Price is configured.
 */
export function serviceFeeAddInvoiceItems(
  settings: ServiceFeeConfig,
): { price: string; quantity: number }[] | undefined {
  if (!serviceFeeEnabled(settings)) return undefined;
  const priceId = settings?.service_fee_price_id?.trim();
  if (!priceId) return undefined;
  return [{ price: priceId, quantity: 1 }];
}

/**
 * `application_fee_amount` (cents) for Connect destination charges (wallet money
 * movement), routing the flat service fee to the Bubaly platform account.
 */
export function serviceFeeApplicationAmount(settings: ServiceFeeConfig): number {
  return serviceFeeEnabled(settings) ? resolveServiceFeeCents(settings) : 0;
}
