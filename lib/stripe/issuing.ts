// lib/stripe/issuing.ts — Stripe Issuing: cardholders, virtual/physical cards,
// controls, and real-time authorization helpers. Fully capability-gated.

import { getStripe } from '@/lib/stripe';
import type { SupabaseClient } from '@supabase/supabase-js';

// Stripe tables not in generated types yet — accept untyped client
type DB = SupabaseClient;

export type CardType = 'virtual' | 'physical';

export type CardControls = {
  dailyLimitCents?: number;
  weeklyLimitCents?: number;
  monthlyLimitCents?: number;
  perTransactionLimitCents?: number;
  allowOnline: boolean;
  allowInStore: boolean;
  allowAtm: boolean;
  blockedCategories: string[];
  parentApprovalThresholdCents?: number;
};

const DEFAULT_BLOCKED_CATEGORIES = [
  'gambling_establishments', 'gambling_chips', 'betting', 'adult_entertainment',
  'liquor_stores', 'tobacco', 'cash_advance', 'cryptocurrency_exchanges',
  'gun_shops', 'atm_s_and_cash_dispensers',
];

export type CardholderResult = { ok: boolean; cardholderId?: string; error?: string };
export type CardResult = { ok: boolean; cardId?: string; last4?: string; error?: string };

/** Get or create a Stripe cardholder for a child member. */
export async function getOrCreateCardholder(
  supabase: DB,
  params: {
    familyId: string;
    memberName: string;
    memberEmail?: string;
    billingAddress: {
      line1: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    };
    connectedAccountId: string;
  }
): Promise<CardholderResult> {
  // Check existing cardholder
  const { data: existing } = await supabase
    .from('stripe_cardholders')
    .select('cardholder_id')
    .eq('family_id', params.familyId)
    .maybeSingle();

  if (existing?.cardholder_id) return { ok: true, cardholderId: existing.cardholder_id };

  try {
    const stripe = getStripe();
    const cardholder = await stripe.issuing.cardholders.create(
      {
        type: 'individual',
        name: params.memberName,
        email: params.memberEmail,
        billing: {
          address: {
            line1: params.billingAddress.line1,
            city: params.billingAddress.city,
            state: params.billingAddress.state,
            postal_code: params.billingAddress.postalCode,
            country: params.billingAddress.country,
          },
        },
        status: 'active',
        metadata: { family_id: params.familyId, app: 'bubaly' },
      },
      { stripeAccount: params.connectedAccountId }
    );

    await supabase.from('stripe_cardholders').insert({
      family_id: params.familyId,
      cardholder_id: cardholder.id,
      status: 'active',
      name: params.memberName,
    });

    return { ok: true, cardholderId: cardholder.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create cardholder' };
  }
}

/** Create a virtual or physical card for a child. */
export async function createCard(
  supabase: DB,
  params: {
    familyId: string;
    childWalletId: string;
    cardholderId: string;
    type: CardType;
    currency: string;
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
    connectedAccountId: string;
    createdBy: string;
  }
): Promise<CardResult> {
  try {
    const stripe = getStripe();

    const spendingLimits = buildSpendingLimits(params.controls);
    const blockedCategories = [
      ...DEFAULT_BLOCKED_CATEGORIES,
      ...params.controls.blockedCategories,
    ].filter((v, i, a) => a.indexOf(v) === i);

    if (!params.controls.allowAtm) {
      if (!blockedCategories.includes('atm_s_and_cash_dispensers')) {
        blockedCategories.push('atm_s_and_cash_dispensers');
      }
    }

    const cardParams: Record<string, unknown> = {
      cardholder: params.cardholderId,
      currency: params.currency.toLowerCase(),
      type: params.type,
      status: 'active',
      spending_controls: {
        spending_limits: spendingLimits,
        blocked_categories: blockedCategories,
      },
      metadata: {
        family_id: params.familyId,
        child_wallet_id: params.childWalletId,
        app: 'bubaly',
      },
    };

    if (params.type === 'physical' && params.shippingAddress) {
      cardParams.shipping = {
        name: params.shippingName ?? params.cardholderId,
        address: {
          line1: params.shippingAddress.line1,
          city: params.shippingAddress.city,
          state: params.shippingAddress.state,
          postal_code: params.shippingAddress.postalCode,
          country: params.shippingAddress.country,
        },
      };
    }

    if (params.designId) {
      cardParams.personalization_design = params.designId;
    }

    const card = await stripe.issuing.cards.create(
      cardParams as unknown as Parameters<typeof stripe.issuing.cards.create>[0],
      { stripeAccount: params.connectedAccountId }
    );

    await supabase.from('stripe_issuing_cards').insert({
      family_id: params.familyId,
      child_wallet_id: params.childWalletId,
      card_id: card.id,
      cardholder_id: params.cardholderId,
      type: params.type,
      status: 'active',
      last4: card.last4,
      exp_month: card.exp_month,
      exp_year: card.exp_year,
      brand: card.brand,
      personalization_design_id: params.designId ?? null,
      created_by: params.createdBy,
    });

    await supabase.from('card_controls').insert({
      family_id: params.familyId,
      card_id: card.id,
      daily_limit_cents: params.controls.dailyLimitCents ?? null,
      weekly_limit_cents: params.controls.weeklyLimitCents ?? null,
      monthly_limit_cents: params.controls.monthlyLimitCents ?? null,
      per_txn_limit_cents: params.controls.perTransactionLimitCents ?? null,
      allow_online: params.controls.allowOnline,
      allow_in_store: params.controls.allowInStore,
      allow_atm: params.controls.allowAtm,
      blocked_categories: blockedCategories,
      parent_approval_threshold_cents: params.controls.parentApprovalThresholdCents ?? null,
    });

    return { ok: true, cardId: card.id, last4: card.last4 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create card' };
  }
}

/** Freeze a card immediately. */
export async function freezeCard(
  supabase: DB,
  cardId: string,
  connectedAccountId: string,
  familyId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const stripe = getStripe();
    await stripe.issuing.cards.update(
      cardId,
      { status: 'inactive' },
      { stripeAccount: connectedAccountId }
    );
    await supabase
      .from('stripe_issuing_cards')
      .update({ status: 'inactive' })
      .eq('card_id', cardId)
      .eq('family_id', familyId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not freeze card' };
  }
}

/** Unfreeze a card. */
export async function unfreezeCard(
  supabase: DB,
  cardId: string,
  connectedAccountId: string,
  familyId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const stripe = getStripe();
    await stripe.issuing.cards.update(
      cardId,
      { status: 'active' },
      { stripeAccount: connectedAccountId }
    );
    await supabase
      .from('stripe_issuing_cards')
      .update({ status: 'active' })
      .eq('card_id', cardId)
      .eq('family_id', familyId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not unfreeze card' };
  }
}

/** Cancel a card permanently. */
export async function cancelCard(
  supabase: DB,
  cardId: string,
  connectedAccountId: string,
  familyId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const stripe = getStripe();
    await stripe.issuing.cards.update(
      cardId,
      { status: 'canceled' },
      { stripeAccount: connectedAccountId }
    );
    await supabase
      .from('stripe_issuing_cards')
      .update({ status: 'canceled' })
      .eq('card_id', cardId)
      .eq('family_id', familyId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not cancel card' };
  }
}

/** Update spending controls on an existing card. */
export async function updateCardControls(
  supabase: DB,
  cardId: string,
  controls: CardControls,
  connectedAccountId: string,
  familyId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const stripe = getStripe();
    const spendingLimits = buildSpendingLimits(controls);
    const blockedCategories = [
      ...DEFAULT_BLOCKED_CATEGORIES,
      ...controls.blockedCategories,
    ].filter((v, i, a) => a.indexOf(v) === i);
    if (!controls.allowAtm && !blockedCategories.includes('atm_s_and_cash_dispensers')) {
      blockedCategories.push('atm_s_and_cash_dispensers');
    }

    await stripe.issuing.cards.update(
      cardId,
      {
        spending_controls: {
          spending_limits: spendingLimits,
          blocked_categories: blockedCategories,
        },
      } as unknown as Parameters<typeof stripe.issuing.cards.update>[1],
      { stripeAccount: connectedAccountId }
    );

    await supabase.from('card_controls')
      .update({
        daily_limit_cents: controls.dailyLimitCents ?? null,
        weekly_limit_cents: controls.weeklyLimitCents ?? null,
        monthly_limit_cents: controls.monthlyLimitCents ?? null,
        per_txn_limit_cents: controls.perTransactionLimitCents ?? null,
        allow_online: controls.allowOnline,
        allow_in_store: controls.allowInStore,
        allow_atm: controls.allowAtm,
        blocked_categories: blockedCategories,
        parent_approval_threshold_cents: controls.parentApprovalThresholdCents ?? null,
      })
      .eq('card_id', cardId)
      .eq('family_id', familyId);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not update card controls' };
  }
}

function buildSpendingLimits(controls: CardControls) {
  type Interval = 'daily' | 'weekly' | 'monthly' | 'per_authorization';
  const limits: { amount: number; interval: Interval }[] = [];
  if (controls.dailyLimitCents) limits.push({ amount: controls.dailyLimitCents, interval: 'daily' });
  if (controls.weeklyLimitCents) limits.push({ amount: controls.weeklyLimitCents, interval: 'weekly' });
  if (controls.monthlyLimitCents) limits.push({ amount: controls.monthlyLimitCents, interval: 'monthly' });
  if (controls.perTransactionLimitCents) limits.push({ amount: controls.perTransactionLimitCents, interval: 'per_authorization' });
  return limits;
}
