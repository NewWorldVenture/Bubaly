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
import { wroteNoRows } from '@/lib/supabase/errors';

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
  const { data: existing, error: lookupError } = await supabase
    .from('stripe_connected_accounts')
    .select('id, stripe_account_id')
    .eq('family_id', params.familyId)
    .maybeSingle();
  if (lookupError) throw new Error('Could not load the existing connected account');
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

/**
 * Pull the latest account state from Stripe and mirror it into our table. True
 * when a row was mirrored; false when no row pairs this family with this
 * account (logged, see below).
 */
export async function syncConnectedAccount(supabase: DB, familyId: string, accountId: string): Promise<boolean> {
  const stripe = getStripe();
  const acct = await stripe.accounts.retrieve(accountId);
  // The result was discarded whole. This mirror is what the wallet reads to
  // decide whether charges and payouts are enabled, so a refused write left the
  // family looking un-onboarded after they finished — and "refresh" answered ok
  // over it. Every caller handles a throw: the money action reports it, the
  // cards page catches it, and in the webhook it is a 500 that Stripe retries,
  // which is what `lib/stripe/webhook.ts` says a reconciler should do when it
  // could not reconcile. Zero rows is logged, NOT thrown: an account row that is
  // gone has nothing to mirror, and throwing would have Stripe retry for days.
  // Audit C1-S9-64.
  //
  // Bound to BOTH the family and the account the state was retrieved for. The
  // money webhook takes the family from the account's metadata, which this
  // platform writes but a Dashboard edit or an orphaned duplicate account could
  // carry for another family; filtered on family_id alone, that family's mirror
  // took on the other account's state (the table is unique on each column, so
  // a mismatch is exactly one wrong row). With the account id in the predicate
  // a mismatch matches zero rows, which the caller logs as a skip. The other
  // callers pass the family's own stored account id, for which the extra
  // predicate changes nothing. Audit N12.
  const { data: mirrored, error } = await supabase
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
    .eq('family_id', familyId)
    .eq('stripe_account_id', accountId)
    .select('id');
  if (error) throw new Error('Stripe connected-account mirror update failed');
  if (wroteNoRows(mirrored)) {
    console.error('[money] connected account changed at Stripe but no mirror row matched', { familyId, accountId });
    return false;
  }
  return true;
}
