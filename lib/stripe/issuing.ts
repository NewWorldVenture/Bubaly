// lib/stripe/issuing.ts — Stripe Issuing: cardholders + child debit/prepaid cards.
//
// Cards are spending instruments tied to a child's wallet. Authorizations are
// approved/declined in real time against the child's SPEND bucket balance (see
// lib/stripe/webhook.ts). We persist non-sensitive card metadata only (last4,
// brand, expiry); the PAN is never stored — parents reveal full details via an
// ephemeral Stripe.js session.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getStripe } from '@/lib/stripe';

type DB = SupabaseClient<Database>;

const WINDOW_INTERVAL: Record<string, 'per_authorization' | 'daily' | 'weekly' | 'monthly' | 'all_time'> = {
  per_authorization: 'per_authorization', daily: 'daily', weekly: 'weekly', monthly: 'monthly', all_time: 'all_time',
};

/** Ensure a Stripe cardholder exists for a child member. Returns the cardholder row id. */
export async function ensureCardholder(
  supabase: DB,
  params: { familyId: string; memberId: string; childWalletId: string; name: string; accountId: string; userId: string | null },
): Promise<{ rowId: string; stripeCardholderId: string }> {
  const { data: existing } = await supabase
    .from('stripe_cardholders')
    .select('id, stripe_cardholder_id')
    .eq('family_id', params.familyId)
    .eq('member_id', params.memberId)
    .maybeSingle();
  if (existing) return { rowId: existing.id, stripeCardholderId: existing.stripe_cardholder_id };

  const stripe = getStripe();

  // Stripe Issuing requires a billing address. We reuse the verified address the
  // parent already submitted during onboarding (on the connected account), so we
  // never collect or store it ourselves.
  const acct = await stripe.accounts.retrieve(params.accountId);
  const addr = acct.individual?.address ?? acct.company?.address ?? null;
  if (!addr?.line1 || !addr.city || !addr.state || !addr.postal_code) {
    throw new Error('Finish account setup (home address) before issuing a card.');
  }

  const cardholder = await stripe.issuing.cardholders.create(
    {
      name: params.name,
      type: 'individual',
      status: 'active',
      billing: {
        address: {
          line1: addr.line1,
          line2: addr.line2 ?? undefined,
          city: addr.city,
          state: addr.state,
          postal_code: addr.postal_code,
          country: addr.country ?? 'US',
        },
      },
      metadata: { family_id: params.familyId, child_wallet_id: params.childWalletId },
    },
    { stripeAccount: params.accountId, idempotencyKey: `cardholder-${params.memberId}` },
  );

  const { data: row, error } = await supabase
    .from('stripe_cardholders')
    .insert({
      family_id: params.familyId, member_id: params.memberId, child_wallet_id: params.childWalletId,
      stripe_cardholder_id: cardholder.id, created_by: params.userId,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to persist cardholder: ${error.message}`);
  return { rowId: row.id, stripeCardholderId: cardholder.id };
}

/** Issue a card for a child wallet. Mirrors spending controls to Stripe. */
export async function issueCard(
  supabase: DB,
  params: {
    familyId: string; childWalletId: string; cardholderRowId: string; stripeCardholderId: string;
    accountId: string; type: 'virtual' | 'physical'; spendLimitCents: number | null;
    spendWindow: string; userId: string | null;
  },
): Promise<{ rowId: string; stripeCardId: string }> {
  const stripe = getStripe();
  const interval = WINDOW_INTERVAL[params.spendWindow] ?? 'per_authorization';
  const card = await stripe.issuing.cards.create(
    {
      cardholder: params.stripeCardholderId,
      currency: 'usd',
      type: params.type,
      status: 'active',
      spending_controls: params.spendLimitCents != null
        ? { spending_limits: [{ amount: params.spendLimitCents, interval }] }
        : undefined,
      metadata: { family_id: params.familyId, child_wallet_id: params.childWalletId },
    },
    { stripeAccount: params.accountId, idempotencyKey: `card-${params.childWalletId}-${Date.now()}` },
  );

  const { data: row, error } = await supabase
    .from('stripe_issuing_cards')
    .insert({
      family_id: params.familyId, child_wallet_id: params.childWalletId, cardholder_id: params.cardholderRowId,
      stripe_card_id: card.id, type: params.type, status: 'active',
      last4: card.last4 ?? null, brand: card.brand ?? null,
      exp_month: card.exp_month ?? null, exp_year: card.exp_year ?? null,
      spend_limit_cents: params.spendLimitCents, spend_window: params.spendWindow,
      created_by: params.userId,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to persist card: ${error.message}`);
  return { rowId: row.id, stripeCardId: card.id };
}

/** Freeze / unfreeze a card (parent control). Updates Stripe + our mirror. */
export async function setCardFrozen(
  supabase: DB,
  params: { familyId: string; cardRowId: string; stripeCardId: string; accountId: string; frozen: boolean },
): Promise<void> {
  const stripe = getStripe();
  await stripe.issuing.cards.update(
    params.stripeCardId,
    { status: params.frozen ? 'inactive' : 'active' },
    { stripeAccount: params.accountId },
  );
  await supabase
    .from('stripe_issuing_cards')
    .update({ is_frozen: params.frozen, status: params.frozen ? 'inactive' : 'active' })
    .eq('id', params.cardRowId)
    .eq('family_id', params.familyId);
}
