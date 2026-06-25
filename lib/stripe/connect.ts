// lib/stripe/connect.ts — Stripe Connect account management for Bubaly Money.
// Each parent family gets a Connect Express account for real-money flows.
// Falls back gracefully: all functions return null/error when Stripe is not configured.

import { getStripe } from '@/lib/stripe';
import type { SupabaseClient } from '@supabase/supabase-js';

// Stripe tables not in generated types yet — accept untyped client
type DB = SupabaseClient;

export type ConnectAccountResult = {
  ok: boolean;
  accountId?: string;
  error?: string;
};

/** Get or create a Stripe Connect account for this family. */
export async function getOrCreateConnectAccount(
  supabase: DB,
  familyId: string,
  userId: string,
  userEmail: string,
): Promise<ConnectAccountResult> {
  // Check if one already exists
  const { data: existing } = await supabase
    .from('stripe_connected_accounts')
    .select('account_id, status')
    .eq('family_id', familyId)
    .maybeSingle();

  if (existing?.account_id) {
    return { ok: true, accountId: existing.account_id };
  }

  try {
    const stripe = getStripe();
    const account = await stripe.accounts.create({
      type: 'express',
      email: userEmail,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      metadata: { family_id: familyId, created_by: userId, app: 'bubaly' },
    });

    await supabase.from('stripe_connected_accounts').insert({
      family_id: familyId,
      account_id: account.id,
      status: 'pending',
      charges_enabled: false,
      payouts_enabled: false,
      created_by: userId,
    });

    return { ok: true, accountId: account.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create Stripe account' };
  }
}

/** Create a Stripe Account Link for Connect onboarding. */
export async function createAccountLink(
  accountId: string,
  refreshUrl: string,
  returnUrl: string,
): Promise<{ url: string | null; error?: string }> {
  try {
    const stripe = getStripe();
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });
    return { url: link.url };
  } catch (err) {
    return { url: null, error: err instanceof Error ? err.message : 'Could not create onboarding link' };
  }
}

/** Sync the Connect account status back to the DB after onboarding. */
export async function syncConnectAccount(
  supabase: DB,
  familyId: string,
  accountId: string,
): Promise<{ ok: boolean; chargesEnabled: boolean; payoutsEnabled: boolean }> {
  try {
    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(accountId);

    await supabase
      .from('stripe_connected_accounts')
      .update({
        charges_enabled: account.charges_enabled ?? false,
        payouts_enabled: account.payouts_enabled ?? false,
        status: account.charges_enabled ? 'active' : 'pending',
        details_submitted: account.details_submitted ?? false,
      })
      .eq('family_id', familyId)
      .eq('account_id', accountId);

    return {
      ok: true,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
    };
  } catch {
    return { ok: false, chargesEnabled: false, payoutsEnabled: false };
  }
}

/** Get or create a Stripe Customer for the family. */
export async function getOrCreateCustomer(
  supabase: DB,
  familyId: string,
  userId: string,
  userEmail: string,
  name?: string,
): Promise<{ customerId: string | null; error?: string }> {
  const { data: existing } = await supabase
    .from('stripe_customers')
    .select('customer_id')
    .eq('family_id', familyId)
    .maybeSingle();

  if (existing?.customer_id) return { customerId: existing.customer_id };

  try {
    const stripe = getStripe();
    const customer = await stripe.customers.create({
      email: userEmail,
      name: name ?? undefined,
      metadata: { family_id: familyId, user_id: userId, app: 'bubaly' },
    });

    await supabase.from('stripe_customers').insert({
      family_id: familyId,
      user_id: userId,
      customer_id: customer.id,
    });

    return { customerId: customer.id };
  } catch (err) {
    return { customerId: null, error: err instanceof Error ? err.message : 'Could not create customer' };
  }
}
