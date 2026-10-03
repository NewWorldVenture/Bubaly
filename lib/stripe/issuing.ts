// lib/stripe/issuing.ts — Stripe Issuing: cardholders + child debit/prepaid cards.
//
// Cards are spending instruments tied to a child's wallet. Authorizations are
// approved/declined in real time against the child's SPEND bucket balance (see
// lib/stripe/webhook.ts). We persist non-sensitive card metadata only (last4,
// brand, expiry); the PAN is never stored — parents reveal full details via an
// ephemeral Stripe.js session.
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import type { Database } from '@/lib/database.types';
import { getStripe } from '@/lib/stripe';
import { wroteNoRows } from '@/lib/supabase/errors';

type DB = SupabaseClient<Database>;

const WINDOW_INTERVAL: Record<string, 'per_authorization' | 'daily' | 'weekly' | 'monthly' | 'all_time'> = {
  per_authorization: 'per_authorization', daily: 'daily', weekly: 'weekly', monthly: 'monthly', all_time: 'all_time',
};

/** Ensure a Stripe cardholder exists for a child member. Returns the cardholder row id. */
export async function ensureCardholder(
  supabase: DB,
  params: { familyId: string; memberId: string; childWalletId: string; name: string; accountId: string; userId: string | null },
): Promise<{ rowId: string; stripeCardholderId: string }> {
  const { data: existing, error: lookupError } = await supabase
    .from('stripe_cardholders')
    .select('id, stripe_cardholder_id')
    .eq('family_id', params.familyId)
    .eq('member_id', params.memberId)
    .maybeSingle();
  if (lookupError) throw new Error('Could not load the existing cardholder');
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
  if (error) {
    // Two first orders for one child (Virtual and the physical dialog claim
    // separately) both miss the lookup, and the stable key above gives both the
    // SAME provider cardholder — so the second insert meets the first one's row
    // under UNIQUE (family_id, member_id) and the order was refused for nothing.
    // Adopt that row only when it is exactly this family, this member and this
    // provider cardholder; anything else, including a failed re-read, keeps the
    // refusal. Audit JIMMY-SUPPORT-CARD-RETRY-20261001 (R5).
    if (error.code === '23505') {
      const winner = await supabase
        .from('stripe_cardholders')
        .select('id, family_id, member_id, stripe_cardholder_id')
        .eq('family_id', params.familyId)
        .eq('member_id', params.memberId)
        .maybeSingle()
        .then(({ data, error: rereadError }) => {
          if (!rereadError) return data;
          console.error('[money] cardholder duplicate re-read failed; keeping the refusal', { memberId: params.memberId, code: rereadError.code });
          return null;
        }, () => {
          console.error('[money] cardholder duplicate re-read rejected; keeping the refusal', { memberId: params.memberId });
          return null;
        });
      if (winner && winner.family_id === params.familyId && winner.member_id === params.memberId
        && winner.stripe_cardholder_id === cardholder.id) {
        return { rowId: winner.id, stripeCardholderId: cardholder.id };
      }
    }
    throw new Error(`Failed to persist cardholder: ${error.message}`);
  }
  return { rowId: row.id, stripeCardholderId: cardholder.id };
}

/**
 * A card order made against a count of the child's cards of its type that the
 * mirror no longer holds: the view that sent it is stale (another tab or
 * device ordered since it last read). Thrown before the provider is asked for
 * anything, so the caller can tell it from a failure and ask for a refresh.
 */
export class StaleCardOrderError extends Error {
  readonly expectedCount: number;
  readonly mirroredCount: number;

  constructor(expectedCount: number, mirroredCount: number) {
    super(`Card order made against ${expectedCount} existing cards; ${mirroredCount} are mirrored`);
    this.name = 'StaleCardOrderError';
    this.expectedCount = expectedCount;
    this.mirroredCount = mirroredCount;
  }
}

/**
 * Issue a card for a child wallet. Mirrors spending controls to Stripe.
 * `expectedCount` is how many of this child's cards of this type the ordering
 * view showed; an order whose count the mirror has moved past throws
 * StaleCardOrderError. `adopted` is true when this call did not mirror a new
 * card but met the exact row another request for the same attempt already wrote.
 */
export async function issueCard(
  supabase: DB,
  params: {
    familyId: string; childWalletId: string; cardholderRowId: string; stripeCardholderId: string;
    accountId: string; type: 'virtual' | 'physical'; spendLimitCents: number | null;
    spendWindow: string; userId: string | null; expectedCount: number;
  },
): Promise<{ rowId: string; stripeCardId: string; adopted: boolean }> {
  // The attempt this order belongs to. One order sent twice — two tabs, two
  // devices, a re-click — before its card is mirrored reads the same count of
  // this child's cards of this type, so both requests carry one idempotency key
  // and the provider replays the first card (same parameters) or refuses the
  // second (different parameters, or the first still executing) instead of
  // issuing two. Once a card is mirrored the count moves on, so a later order
  // is a new attempt. Every status counts, and app code never deletes these
  // rows; the cardholder ROW id keeps a recreated cardholder (whose cards
  // cascaded away) from reusing an earlier key. A count that cannot be read is
  // not zero: nothing reaches the provider without it.
  // Audit JIMMY-SUPPORT-CARD-RETRY-20261001 (repair B).
  const { count: mirrored, error: countError } = await supabase
    .from('stripe_issuing_cards')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', params.familyId)
    .eq('child_wallet_id', params.childWalletId)
    .eq('type', params.type);
  if (countError || mirrored === null || !Number.isSafeInteger(mirrored) || mirrored < 0) {
    throw new Error('Could not count the existing cards');
  }
  // The count is also the one the order was made against. A view that still
  // shows N cards after another tab's card was mirrored (N+1) would otherwise
  // read as a new attempt and issue a second card: the server cannot tell it
  // from a deliberate order, so the view says what it saw. Either direction is
  // stale; the view re-reads and orders against what exists. Orders that
  // overlap before the first is mirrored still match and share one key.
  // Audit JIMMY-SUPPORT-CARD-RETRY-20261001 (stale-order guard).
  if (mirrored !== params.expectedCount) throw new StaleCardOrderError(params.expectedCount, mirrored);

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
    {
      stripeAccount: params.accountId,
      idempotencyKey: `card-${params.cardholderRowId}-${params.childWalletId}-${params.type}-${mirrored}`,
    },
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
  if (error) {
    // The provider replayed a card another request of this attempt already
    // mirrored, so this insert met that row under UNIQUE (stripe_card_id).
    // Adopt it only when it is exactly this family, child, type, cardholder row
    // and provider card. Its controls, freeze, status and author may have
    // changed since, legitimately, so they are not compared. Anything else,
    // including a failed re-read, keeps the refusal.
    if (error.code === '23505') {
      const winner = await supabase
        .from('stripe_issuing_cards')
        .select('id, family_id, child_wallet_id, type, cardholder_id, stripe_card_id')
        .eq('stripe_card_id', card.id)
        .maybeSingle()
        .then(({ data, error: rereadError }) => {
          if (!rereadError) return data;
          console.error('[money] card duplicate re-read failed; keeping the refusal', { stripeCardId: card.id, code: rereadError.code });
          return null;
        }, () => {
          console.error('[money] card duplicate re-read rejected; keeping the refusal', { stripeCardId: card.id });
          return null;
        });
      if (winner && winner.stripe_card_id === card.id && winner.family_id === params.familyId
        && winner.child_wallet_id === params.childWalletId && winner.type === params.type
        && winner.cardholder_id === params.cardholderRowId) {
        return { rowId: winner.id, stripeCardId: card.id, adopted: true };
      }
    } else {
      // The card is live at the provider with no mirror row; name it so it can
      // be found. An identical retry within the provider's key window replays
      // it, but nothing here cancels it.
      console.error('[money] card mirror insert failed after the provider created the card', { stripeCardId: card.id, code: error.code });
    }
    throw new Error(`Failed to persist card: ${error.message}`);
  }
  return { rowId: row.id, stripeCardId: card.id, adopted: false };
}

/** Update a card's spending controls (limit + window + blocked categories). */
export async function updateCardControls(
  supabase: DB,
  params: {
    familyId: string; cardRowId: string; stripeCardId: string; accountId: string;
    spendLimitCents: number | null; spendWindow: string; blockedCategories: string[];
  },
): Promise<void> {
  const stripe = getStripe();
  const interval = WINDOW_INTERVAL[params.spendWindow] ?? 'per_authorization';
  const spending_controls: Stripe.Issuing.CardUpdateParams.SpendingControls = {
    // Empty array clears any existing limits; otherwise set the single limit.
    spending_limits: params.spendLimitCents != null
      ? [{ amount: params.spendLimitCents, interval }]
      : [],
    blocked_categories: params.blockedCategories as Stripe.Issuing.CardUpdateParams.SpendingControls.BlockedCategory[],
  };
  await stripe.issuing.cards.update(
    params.stripeCardId,
    { spending_controls },
    { stripeAccount: params.accountId },
  );
  // The Stripe update above is what actually constrains the card, and its
  // failure reaches the caller. This is our MIRROR of it, and its result used to
  // be discarded — so a refused write left /wallet showing a limit the card no
  // longer had, with nothing to correct it. It is logged rather than thrown
  // because the control did take effect and the change is now reconciled by
  // issuing_card.updated (lib/stripe/webhook.ts): telling the parent this failed
  // would be the more misleading answer of the two.
  // And a write matching no row is the same stale display by another route —
  // logged with it, not thrown, for the reason above. Audit C1-S9-64.
  const { data: controlled, error } = await supabase
    .from('stripe_issuing_cards')
    .update({
      spend_limit_cents: params.spendLimitCents,
      spend_window: params.spendWindow,
      blocked_categories: params.blockedCategories,
    })
    .eq('id', params.cardRowId)
    .eq('family_id', params.familyId)
    // A rejected mirror is the same best-effort failure as a returned error.
    .select('id').then(undefined, () => ({ data: null, error: true }));
  if (error || wroteNoRows(controlled)) {
    console.error('[money] card controls changed at Stripe but the mirror write failed; issuing_card.updated reconciles it',
      { cardRowId: params.cardRowId });
  }
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
  // Same as updateCardControls: the freeze is real at Stripe by here, so a
  // failed mirror write is a stale DISPLAY, not a failed freeze, and
  // issuing_card.updated corrects it.
  const { data: frozenRow, error } = await supabase
    .from('stripe_issuing_cards')
    .update({ is_frozen: params.frozen, status: params.frozen ? 'inactive' : 'active' })
    .eq('id', params.cardRowId)
    .eq('family_id', params.familyId)
    .select('id').then(undefined, () => ({ data: null, error: true }));
  if (error || wroteNoRows(frozenRow)) {
    console.error('[money] card freeze changed at Stripe but the mirror write failed; issuing_card.updated reconciles it',
      { cardRowId: params.cardRowId, frozen: params.frozen });
  }
}
