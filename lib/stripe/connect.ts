// lib/stripe/connect.ts — Stripe Connect parent onboarding (KYC).
//
// A family must have a connected account before Treasury or Issuing can run.
// We create a custom/Express account, generate a hosted onboarding link, and
// mirror Stripe's reported status into stripe_connected_accounts. We store only
// IDs + status booleans — never the underlying identity documents.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, StripeAccountStatus } from '@/lib/database.types';
import { getStripe } from '@/lib/stripe';
import type Stripe from 'stripe';

type DB = SupabaseClient<Database>;

/** Map a Stripe account object to our coarse status enum. */
export function accountStatus(acct: Stripe.Account): StripeAccountStatus {
  if (acct.charges_enabled && acct.payouts_enabled) return 'enabled';
  if ((acct.requirements?.disabled_reason ?? null) !== null) return 'disabled';
  if (acct.details_submitted) return 'restricted';
  return 'pending';
}

/** True when a given capability is 'active' on the account. */
function capActive(acct: Stripe.Account, cap: string): boolean {
  const caps = (acct.capabilities ?? {}) as Record<string, string | undefined>;
  return caps[cap] === 'active';
}

/**
 * Ensure a connected account exists for the family. Returns the Stripe account id.
 * Idempotent: reuses the stored account if present.
 */
export async function ensureConnectedAccount(
  supabase: DB,
  params: { familyId: string; email: string | null; userId: string | null },
): Promise<{ accountId: string; rowId: string }> {
  const { data: existing } = await supabase
    .from('stripe_connected_accounts')
    .select('id, stripe_account_id')
    .eq('family_id', params.familyId)
    .maybeSingle();
  if (existing) return { accountId: existing.stripe_account_id, rowId: existing.id };

  const stripe = getStripe();
  const account = await stripe.accounts.create(
    {
      type: 'custom',
      country: 'US',
      email: params.email ?? undefined,
      business_type: 'individual',
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
        treasury: { requested: true },
        card_issuing: { requested: true },
      },
      metadata: { family_id: params.familyId },
    },
    { idempotencyKey: `connect-acct-${params.familyId}` },
  );

  const { data: row, error } = await supabase
    .from('stripe_connected_accounts')
    .insert({
      family_id: params.familyId,
      stripe_account_id: account.id,
      status: accountStatus(account),
      details_submitted: account.details_submitted ?? false,
      onboarded_by: params.userId,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to persist connected account: ${error.message}`);

  return { accountId: account.id, rowId: row.id };
}

/** Create a hosted onboarding link for the family's connected account. */
export async function createOnboardingLink(
  accountId: string,
  opts: { returnUrl: string; refreshUrl: string },
): Promise<string> {
  const stripe = getStripe();
  const link = await stripe.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    return_url: opts.returnUrl,
    refresh_url: opts.refreshUrl,
  });
  return link.url;
}

/** Pull the latest account state from Stripe and mirror it into our table. */
export async function syncConnectedAccount(supabase: DB, familyId: string, accountId: string): Promise<void> {
  const stripe = getStripe();
  const acct = await stripe.accounts.retrieve(accountId);
  await supabase
    .from('stripe_connected_accounts')
    .update({
      status: accountStatus(acct),
      charges_enabled: acct.charges_enabled ?? false,
      payouts_enabled: acct.payouts_enabled ?? false,
      details_submitted: acct.details_submitted ?? false,
      treasury_enabled: capActive(acct, 'treasury'),
      card_issuing_enabled: capActive(acct, 'card_issuing'),
      requirements_due: (acct.requirements?.currently_due ?? []) as unknown as Database['public']['Tables']['stripe_connected_accounts']['Update']['requirements_due'],
    })
    .eq('family_id', familyId);
}
