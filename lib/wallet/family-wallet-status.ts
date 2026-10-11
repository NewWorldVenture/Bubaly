import { createServiceClient } from '@/lib/supabase/server';

/**
 * Whether the active family's wallet is switched on, for a page that has
 * already resolved the caller's family.
 *
 * The family wallet's row is a parent's or adult's to read (the held 0514:
 * household money is the managers'), so a child's session reads no row and
 * would be told the wallet was never set up. Whether it is on is not the
 * household's money, and every member's wallet pages turn on it, so it is
 * read here through the service client: that one column of that one family's
 * row, nothing else. Callers pass the family from requireUserContext(), never
 * from the request.
 */
export async function readFamilyWalletIsActive(
  familyId: string,
): Promise<{ data: { is_active: boolean } | null; error: { message: string } | null }> {
  const { data, error } = await createServiceClient()
    .from('family_wallets').select('is_active').eq('family_id', familyId).maybeSingle();
  return { data: data ? { is_active: Boolean(data.is_active) } : null, error };
}

/**
 * Whether the family's Stripe account can issue cards, for the cards page every
 * member's wallet shows. The connected account's row is a parent's or adult's
 * (the held 0514), so a child's session reads none and would be told card
 * setup never started; these four status flags are read here instead, for the
 * family the caller resolved, and nothing else of the row.
 */
export async function readConnectedAccountStatus(familyId: string): Promise<{
  data: { status: string | null; charges_enabled: boolean | null; details_submitted: boolean | null; card_issuing_enabled: boolean | null } | null;
  error: { message: string } | null;
}> {
  const { data, error } = await createServiceClient()
    .from('stripe_connected_accounts')
    .select('status, charges_enabled, details_submitted, card_issuing_enabled').eq('family_id', familyId).maybeSingle();
  return { data: data ?? null, error };
}
