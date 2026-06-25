// lib/stripe/capabilities.ts — Stripe capability detection service.
// Checks the connected Stripe account for supported features and returns a
// structured capability matrix used to gate every money feature in Bubaly.
// Falls back gracefully: unknown/unavailable capabilities disable only that
// feature while leaving the virtual ledger fully operational.

import { getStripe } from '@/lib/stripe';
import type { SupabaseClient } from '@supabase/supabase-js';

export type CapabilityStatus = 'enabled' | 'disabled' | 'pending_review' | 'action_required' | 'unavailable';

export type StripeCapabilityMatrix = {
  // Core
  payments: CapabilityStatus;
  // Connect
  connect: CapabilityStatus;
  connectedAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  // Treasury
  treasury: CapabilityStatus;
  financialAccountId: string | null;
  outboundPayments: CapabilityStatus;
  inboundTransfers: CapabilityStatus;
  // Issuing
  issuing: CapabilityStatus;
  virtualCards: CapabilityStatus;
  physicalCards: CapabilityStatus;
  cardPersonalization: CapabilityStatus;
  realtimeAuthorizations: CapabilityStatus;
  // Payments
  checkoutEnabled: boolean;
  ach: CapabilityStatus;
  instantPayout: CapabilityStatus;
  // Meta
  stripeMode: 'test' | 'live' | 'unconfigured';
  lastCheckedAt: string;
  missingRequirements: string[];
  disabledReasons: string[];
  pendingReasons: string[];
};

export const EMPTY_CAPABILITIES: StripeCapabilityMatrix = {
  payments: 'unavailable',
  connect: 'unavailable',
  connectedAccountId: null,
  chargesEnabled: false,
  payoutsEnabled: false,
  treasury: 'unavailable',
  financialAccountId: null,
  outboundPayments: 'unavailable',
  inboundTransfers: 'unavailable',
  issuing: 'unavailable',
  virtualCards: 'unavailable',
  physicalCards: 'unavailable',
  cardPersonalization: 'unavailable',
  realtimeAuthorizations: 'unavailable',
  checkoutEnabled: false,
  ach: 'unavailable',
  instantPayout: 'unavailable',
  stripeMode: 'unconfigured',
  lastCheckedAt: new Date().toISOString(),
  missingRequirements: [],
  disabledReasons: [],
  pendingReasons: [],
};

function capStatus(status: string | undefined, pendingReqs: string[] = []): CapabilityStatus {
  if (!status) return 'unavailable';
  if (status === 'active') return 'enabled';
  if (status === 'inactive') return pendingReqs.length > 0 ? 'action_required' : 'disabled';
  if (status === 'pending') return 'pending_review';
  if (status === 'unrequested') return 'unavailable';
  return 'disabled';
}

/** Detect capabilities from a Stripe Connect account object. */
export async function detectCapabilities(connectedAccountId: string): Promise<StripeCapabilityMatrix> {
  const stripe = getStripe();
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  const stripeMode: StripeCapabilityMatrix['stripeMode'] = !key
    ? 'unconfigured'
    : key.startsWith('sk_live_')
    ? 'live'
    : 'test';

  try {
    const account = await stripe.accounts.retrieve(connectedAccountId);
    const caps = account.capabilities ?? {};
    const reqs = account.requirements;
    const missingRequirements = reqs?.currently_due ?? [];
    const disabledReasons = reqs?.disabled_reason ? [reqs.disabled_reason] : [];
    const pendingReasons = (reqs?.pending_verification ?? []) as string[];

    // Check Treasury availability by attempting to list financial accounts
    let treasuryStatus: CapabilityStatus = 'unavailable';
    let financialAccountId: string | null = null;
    let outboundPayments: CapabilityStatus = 'unavailable';
    let inboundTransfers: CapabilityStatus = 'unavailable';

    if (caps.treasury === 'active' || (account as unknown as Record<string, unknown>).treasury) {
      treasuryStatus = capStatus(caps.treasury as string | undefined);
      try {
        const fas = await stripe.treasury.financialAccounts.list(
          { limit: 1 },
          { stripeAccount: connectedAccountId }
        );
        if (fas.data.length > 0) {
          financialAccountId = fas.data[0].id;
          const fa = fas.data[0];
          const features = (fa as unknown as { financial_addresses?: unknown; outbound_payments?: { ach?: { status: string } }; inbound_transfers?: { ach?: { status: string } } });
          outboundPayments = features.outbound_payments?.ach?.status === 'active' ? 'enabled' : 'pending_review';
          inboundTransfers = features.inbound_transfers?.ach?.status === 'active' ? 'enabled' : 'pending_review';
        }
      } catch { /* Treasury not available on this account */ }
    }

    // Check Issuing
    const issuingStatus = capStatus(caps.card_issuing as string | undefined, missingRequirements);
    const physicalCardsStatus = capStatus(caps.card_issuing as string | undefined, missingRequirements);

    return {
      payments: account.charges_enabled ? 'enabled' : 'disabled',
      connect: 'enabled',
      connectedAccountId,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
      treasury: treasuryStatus,
      financialAccountId,
      outboundPayments,
      inboundTransfers,
      issuing: issuingStatus,
      virtualCards: issuingStatus,
      physicalCards: physicalCardsStatus,
      cardPersonalization: physicalCardsStatus === 'enabled' ? 'pending_review' : 'unavailable',
      realtimeAuthorizations: issuingStatus === 'enabled' ? 'enabled' : 'unavailable',
      checkoutEnabled: account.charges_enabled ?? false,
      ach: capStatus(caps.us_bank_account_ach_payments as string | undefined),
      instantPayout: 'unavailable', // Requires separate approval
      stripeMode,
      lastCheckedAt: new Date().toISOString(),
      missingRequirements: missingRequirements as string[],
      disabledReasons,
      pendingReasons,
    };
  } catch {
    return { ...EMPTY_CAPABILITIES, stripeMode, lastCheckedAt: new Date().toISOString() };
  }
}

/** Check platform-level Stripe capabilities (no connected account needed). */
export async function detectPlatformCapabilities(): Promise<StripeCapabilityMatrix> {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  if (!key || key.includes('your_secret')) return EMPTY_CAPABILITIES;

  const stripeMode: StripeCapabilityMatrix['stripeMode'] = key.startsWith('sk_live_') ? 'live' : 'test';

  try {
    const stripe = getStripe();
    // Verify the key works by fetching the platform account
    const account = await (stripe.accounts.retrieve as unknown as () => Promise<import('stripe').default.Account>)();
    return {
      payments: 'enabled',
      connect: 'enabled',
      connectedAccountId: null,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
      treasury: 'pending_review',
      financialAccountId: null,
      outboundPayments: 'pending_review',
      inboundTransfers: 'pending_review',
      issuing: 'pending_review',
      virtualCards: 'pending_review',
      physicalCards: 'pending_review',
      cardPersonalization: 'unavailable',
      realtimeAuthorizations: 'unavailable',
      checkoutEnabled: account.charges_enabled ?? false,
      ach: 'pending_review',
      instantPayout: 'unavailable',
      stripeMode,
      lastCheckedAt: new Date().toISOString(),
      missingRequirements: [],
      disabledReasons: [],
      pendingReasons: [],
    };
  } catch {
    return { ...EMPTY_CAPABILITIES, stripeMode, lastCheckedAt: new Date().toISOString() };
  }
}

/** Load capabilities from the DB cache, refresh if stale (>30 min). */
export async function getOrRefreshCapabilities(
  // Stripe tables not in generated types yet — accept untyped client
  supabase: SupabaseClient,
  familyId: string,
  connectedAccountId: string | null,
): Promise<StripeCapabilityMatrix> {
  const { data: cached } = await supabase
    .from('stripe_capabilities')
    .select('*')
    .eq('family_id', familyId)
    .maybeSingle();

  const now = Date.now();
  const cacheAge = cached?.last_checked_at
    ? now - new Date(cached.last_checked_at).getTime()
    : Infinity;
  const STALE_MS = 30 * 60 * 1000; // 30 min

  if (cached && cacheAge < STALE_MS) {
    return (cached.capability_matrix as unknown as StripeCapabilityMatrix) ?? EMPTY_CAPABILITIES;
  }

  const fresh = connectedAccountId
    ? await detectCapabilities(connectedAccountId)
    : await detectPlatformCapabilities();

  await supabase.from('stripe_capabilities').upsert(
    { family_id: familyId, account_id: connectedAccountId, capability_matrix: fresh as unknown as Record<string, unknown>, last_checked_at: fresh.lastCheckedAt },
    { onConflict: 'family_id' }
  );

  return fresh;
}

/** Simple check: is a capability currently enabled? */
export function isEnabled(cap: CapabilityStatus): boolean {
  return cap === 'enabled';
}

/** User-friendly label for a capability status. */
export function capabilityLabel(cap: CapabilityStatus): string {
  switch (cap) {
    case 'enabled': return 'Active';
    case 'disabled': return 'Not available';
    case 'pending_review': return 'Pending review';
    case 'action_required': return 'Action required';
    case 'unavailable': return 'Not configured';
  }
}
