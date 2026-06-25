'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { withStripeTables } from '@/lib/supabase/stripe-tables';
import { getOrCreateConnectAccount, createAccountLink, syncConnectAccount, getOrCreateCustomer } from '@/lib/stripe/connect';
import { getOrCreateCardholder, createCard, freezeCard, unfreezeCard, cancelCard, updateCardControls } from '@/lib/stripe/issuing';
import { getOrRefreshCapabilities } from '@/lib/stripe/capabilities';
import { createTopupCheckoutSession } from '@/lib/stripe/checkout';
import { creditChildWallet } from '@/lib/wallet/server';
import { walletTierForPlanLevel } from '@/lib/wallet/tiers';
import { planLevel } from '@/lib/constants/plans';
import type { CardControls, CardType } from '@/lib/stripe/issuing';

type Result = { ok: boolean; error?: string };

// ─── Connect / Setup ────────────────────────────────────────────────────────

/** Activate Bubaly Money and create a Stripe Connect account for this family. */
export async function activateMoneyAction(): Promise<Result & { accountId?: string }> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can activate Bubaly Money.' };

  const supabase = await createServer();
  const result = await getOrCreateConnectAccount(supabase, ctx.active.familyId, ctx.user.id, ctx.user.email ?? '');
  if (!result.ok) return { ok: false, error: result.error };

  await supabase.from('wallet_audit_logs').insert({
    family_id: ctx.active.familyId,
    actor_user_id: ctx.user.id,
    action: 'money_activated',
    entity_type: 'stripe_connected_accounts',
    entity_id: result.accountId ?? null,
    detail: 'Bubaly Money activated — Stripe Connect account created',
  });

  revalidatePath('/money');
  return { ok: true, accountId: result.accountId };
}

/** Generate a Stripe Connect onboarding link for the parent to complete KYC. */
export async function getConnectOnboardingUrlAction(): Promise<{ url: string | null; error?: string }> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { url: null, error: 'Managers only.' };

  const supabase = await createServer();
  const db = withStripeTables(supabase);
  const { data: account } = await db
    .from('stripe_connected_accounts')
    .select('account_id')
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();

  if (!account?.account_id) return { url: null, error: 'No connected account found. Activate Bubaly Money first.' };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://bubaly.com';
  return createAccountLink(
    account.account_id,
    `${appUrl}/money/setup?refresh=1`,
    `${appUrl}/money/setup?return=1`,
  );
}

/** Sync Connect account status after parent completes KYC onboarding. */
export async function syncConnectAccountAction(): Promise<Result & { chargesEnabled?: boolean }> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Managers only.' };

  const supabase = await createServer();
  const db = withStripeTables(supabase);
  const { data: account } = await db
    .from('stripe_connected_accounts')
    .select('account_id')
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();

  if (!account?.account_id) return { ok: false, error: 'No connected account.' };

  const result = await syncConnectAccount(supabase, ctx.active.familyId, account.account_id);
  revalidatePath('/money');
  return { ok: result.ok, chargesEnabled: result.chargesEnabled };
}

/** Refresh Stripe capability cache for this family. */
export async function refreshCapabilitiesAction(): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Managers only.' };

  const supabase = await createServer();
  const db = withStripeTables(supabase);
  const { data: account } = await db
    .from('stripe_connected_accounts')
    .select('account_id')
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();

  // Force refresh by deleting cache row first
  await db.from('stripe_capabilities').delete().eq('family_id', ctx.active.familyId);
  await getOrRefreshCapabilities(supabase, ctx.active.familyId, account?.account_id ?? null);

  revalidatePath('/money');
  return { ok: true };
}

// ─── Cards ──────────────────────────────────────────────────────────────────

export async function createCardAction(input: {
  childWalletId: string;
  type: CardType;
  controls: CardControls;
  designId?: string;
  shippingName?: string;
  shippingAddress?: {
    line1: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  billingAddress: {
    line1: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  memberName: string;
}): Promise<Result & { cardId?: string; last4?: string }> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can create cards.' };

  const supabase = await createServer();
  const db = withStripeTables(supabase);
  const familyId = ctx.active.familyId;

  const { data: account } = await db
    .from('stripe_connected_accounts')
    .select('account_id, charges_enabled')
    .eq('family_id', familyId)
    .maybeSingle();

  if (!account?.account_id) return { ok: false, error: 'Bubaly Money not set up. Complete setup first.' };
  if (!account.charges_enabled) return { ok: false, error: 'Stripe account not yet approved for charges.' };

  const cardholderResult = await getOrCreateCardholder(supabase, {
    familyId,
    memberName: input.memberName,
    billingAddress: input.billingAddress,
    connectedAccountId: account.account_id,
  });
  if (!cardholderResult.ok) return { ok: false, error: cardholderResult.error };

  const cardResult = await createCard(supabase, {
    familyId,
    childWalletId: input.childWalletId,
    cardholderId: cardholderResult.cardholderId!,
    type: input.type,
    currency: 'usd',
    controls: input.controls,
    designId: input.designId,
    shippingName: input.shippingName,
    shippingAddress: input.shippingAddress,
    connectedAccountId: account.account_id,
    createdBy: ctx.user.id,
  });
  if (!cardResult.ok) return { ok: false, error: cardResult.error };

  await supabase.from('wallet_audit_logs').insert({
    family_id: familyId,
    actor_user_id: ctx.user.id,
    action: 'card_created',
    entity_type: 'stripe_issuing_cards',
    entity_id: cardResult.cardId ?? null,
    detail: `${input.type} card created for child wallet`,
  });

  revalidatePath('/money/cards');
  return { ok: true, cardId: cardResult.cardId, last4: cardResult.last4 };
}

export async function freezeCardAction(input: { cardId: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Managers only.' };

  const supabase = await createServer();
  const db = withStripeTables(supabase);
  const { data: card } = await db
    .from('stripe_issuing_cards')
    .select('family_id')
    .eq('card_id', input.cardId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();

  if (!card) return { ok: false, error: 'Card not found.' };

  const { data: account } = await db
    .from('stripe_connected_accounts')
    .select('account_id')
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();

  const result = await freezeCard(supabase, input.cardId, account?.account_id ?? '', ctx.active.familyId);
  if (!result.ok) return result;

  await supabase.from('wallet_audit_logs').insert({
    family_id: ctx.active.familyId, actor_user_id: ctx.user.id,
    action: 'card_frozen', entity_type: 'stripe_issuing_cards', entity_id: input.cardId,
    detail: 'Card frozen by parent',
  });

  revalidatePath('/money/cards');
  return { ok: true };
}

export async function unfreezeCardAction(input: { cardId: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Managers only.' };

  const supabase = await createServer();
  const db = withStripeTables(supabase);
  const { data: card } = await db
    .from('stripe_issuing_cards')
    .select('family_id')
    .eq('card_id', input.cardId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();

  if (!card) return { ok: false, error: 'Card not found.' };

  const { data: account } = await db
    .from('stripe_connected_accounts')
    .select('account_id')
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();

  const result = await unfreezeCard(supabase, input.cardId, account?.account_id ?? '', ctx.active.familyId);
  if (!result.ok) return result;

  await supabase.from('wallet_audit_logs').insert({
    family_id: ctx.active.familyId, actor_user_id: ctx.user.id,
    action: 'card_unfrozen', entity_type: 'stripe_issuing_cards', entity_id: input.cardId,
    detail: 'Card unfrozen by parent',
  });

  revalidatePath('/money/cards');
  return { ok: true };
}

export async function cancelCardAction(input: { cardId: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Managers only.' };

  const supabase = await createServer();
  const db = withStripeTables(supabase);
  const { data: card } = await db
    .from('stripe_issuing_cards')
    .select('family_id')
    .eq('card_id', input.cardId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();

  if (!card) return { ok: false, error: 'Card not found.' };

  const { data: account } = await db
    .from('stripe_connected_accounts')
    .select('account_id')
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();

  const result = await cancelCard(supabase, input.cardId, account?.account_id ?? '', ctx.active.familyId);
  if (!result.ok) return result;

  await supabase.from('wallet_audit_logs').insert({
    family_id: ctx.active.familyId, actor_user_id: ctx.user.id,
    action: 'card_cancelled', entity_type: 'stripe_issuing_cards', entity_id: input.cardId,
    detail: 'Card permanently cancelled by parent',
  });

  revalidatePath('/money/cards');
  return { ok: true };
}

export async function updateCardControlsAction(input: {
  cardId: string;
  controls: CardControls;
}): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Managers only.' };

  const supabase = await createServer();
  const db = withStripeTables(supabase);
  const { data: card } = await db
    .from('stripe_issuing_cards')
    .select('family_id')
    .eq('card_id', input.cardId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();

  if (!card) return { ok: false, error: 'Card not found.' };

  const { data: account } = await db
    .from('stripe_connected_accounts')
    .select('account_id')
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();

  const result = await updateCardControls(supabase, input.cardId, input.controls, account?.account_id ?? '', ctx.active.familyId);
  if (!result.ok) return result;

  revalidatePath('/money/cards');
  return { ok: true };
}

// ─── Top-up via Stripe Checkout ─────────────────────────────────────────────

export async function createTopupSessionAction(input: {
  childWalletId: string;
  childName: string;
  amountCents: number;
}): Promise<{ ok: boolean; url?: string; error?: string }> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Managers only.' };

  const supabase = await createServer();
  const db = withStripeTables(supabase);
  const familyId = ctx.active.familyId;

  const [{ data: sub }, { data: customer }] = await Promise.all([
    supabase.from('subscriptions').select('plan').eq('family_id', familyId).in('status', ['active', 'trialing']).maybeSingle(),
    db.from('stripe_customers').select('customer_id').eq('family_id', familyId).maybeSingle(),
  ]);

  const tier = walletTierForPlanLevel(planLevel(sub?.plan ?? null));

  let customerId = (customer as { customer_id?: string } | null)?.customer_id;
  if (!customerId) {
    const cust = await getOrCreateCustomer(supabase, familyId, ctx.user.id, ctx.user.email ?? '');
    customerId = cust.customerId ?? undefined;
  }

  const result = await createTopupCheckoutSession({
    amountCents: input.amountCents,
    childName: input.childName,
    familyId,
    childWalletId: input.childWalletId,
    customerId,
    tier,
  });

  if (!result.ok || !result.url) return { ok: false, error: result.error };

  // Track in stripe_checkout_sessions
  await db.from('stripe_checkout_sessions').insert({
    family_id: familyId,
    session_id: result.sessionId!,
    type: 'topup',
    status: 'pending',
    amount_cents: input.amountCents,
    related_id: input.childWalletId,
    metadata: { child_name: input.childName },
  });

  return { ok: true, url: result.url };
}

// ─── Babysitter Payments ─────────────────────────────────────────────────────

export async function payBabysitterAction(input: {
  memberId: string;
  amountCents: number;
  note?: string;
  hours?: number;
}): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Managers only.' };

  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  // Verify the member is in the family
  const { data: member } = await supabase
    .from('family_members')
    .select('id, display_name, role')
    .eq('id', input.memberId)
    .eq('family_id', familyId)
    .maybeSingle();

  if (!member) return { ok: false, error: 'Member not found.' };

  await supabase.from('wallet_audit_logs').insert({
    family_id: familyId,
    actor_user_id: ctx.user.id,
    action: 'babysitter_paid',
    entity_type: 'family_members',
    entity_id: input.memberId,
    detail: JSON.stringify({
      amount_cents: input.amountCents,
      hours: input.hours,
      note: input.note,
      recipient: member.display_name,
    }),
  });

  revalidatePath('/money/babysitters');
  return { ok: true };
}
