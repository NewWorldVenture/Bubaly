// lib/stripe/treasury.ts — Stripe Treasury embedded financial accounts.
//
// A financial account is the family's pooled balance that funds issued cards.
// The immutable ledger remains the source of truth for per-child balances; the
// Treasury balance here is a cached display figure for the parent dashboard.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getStripe } from '@/lib/stripe';

type DB = SupabaseClient<Database>;

/** Ensure a Treasury financial account exists for the family. */
export async function ensureFinancialAccount(
  supabase: DB,
  params: { familyId: string; connectedAccountRowId: string; accountId: string },
): Promise<{ rowId: string; financialAccountId: string }> {
  const { data: existing } = await supabase
    .from('stripe_financial_accounts')
    .select('id, stripe_financial_account_id')
    .eq('family_id', params.familyId)
    .maybeSingle();
  if (existing) return { rowId: existing.id, financialAccountId: existing.stripe_financial_account_id };

  const stripe = getStripe();
  const fa = await stripe.treasury.financialAccounts.create(
    {
      supported_currencies: ['usd'],
      features: {
        card_issuing: { requested: true },
        deposit_insurance: { requested: true },
        financial_addresses: { aba: { requested: true } },
        inbound_transfers: { ach: { requested: true } },
        outbound_payments: { ach: { requested: true }, us_domestic_wire: { requested: true } },
      },
      metadata: { family_id: params.familyId },
    },
    { stripeAccount: params.accountId, idempotencyKey: `fa-${params.familyId}` },
  );

  const { data: row, error } = await supabase
    .from('stripe_financial_accounts')
    .insert({
      family_id: params.familyId,
      connected_account_id: params.connectedAccountRowId,
      stripe_financial_account_id: fa.id,
      status: fa.status ?? 'open',
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to persist financial account: ${error.message}`);
  return { rowId: row.id, financialAccountId: fa.id };
}

/** Refresh the cached Treasury balance for display. */
export async function syncFinancialAccountBalance(
  supabase: DB,
  params: { familyId: string; financialAccountId: string; accountId: string },
): Promise<number> {
  const stripe = getStripe();
  const fa = await stripe.treasury.financialAccounts.retrieve(
    params.financialAccountId,
    undefined,
    { stripeAccount: params.accountId },
  );
  const cash = fa.balance?.cash?.usd ?? 0;
  await supabase
    .from('stripe_financial_accounts')
    .update({ cached_balance_cents: cash, cached_at: new Date().toISOString() })
    .eq('family_id', params.familyId);
  return cash;
}
