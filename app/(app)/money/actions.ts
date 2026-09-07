'use server';

// app/(app)/money/actions.ts — Bubaly Money (Stripe Financial Mode) server actions.
//
// Every action is manager-gated, capability-gated (graceful no-op message when
// Stripe mode isn't available), and writes to the service-role-only stripe_*
// tables via the service client. No secrets ever reach the client. All financial
// state changes are mirrored from Stripe, never forged locally.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { headers } from 'next/headers';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { getMoneyCapabilities } from '@/lib/stripe/capabilities';
import { ensureConnectedAccount, createOnboardingLink, syncConnectedAccount } from '@/lib/stripe/connect';
import { ensureFinancialAccount } from '@/lib/stripe/treasury';
import { ensureCardholder, issueCard, setCardFrozen, updateCardControls } from '@/lib/stripe/issuing';
import { clampSpendLimitCents, normalizeSpendWindow, normalizeBlockedCategories } from '@/lib/wallet/card-controls';
import { evaluateTrust, roleOf } from '@/lib/trust/server';
import { getStripe } from '@/lib/stripe';
import { effectivePublishableKey } from '@/lib/stripe/settings';
import { describeActionError } from '@/lib/supabase/errors';

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

function actionFailure<T = unknown>(operation: string, error: unknown): Result<T> {
  console.error(`[money-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

function logAuditFailure(operation: string, error: unknown): void {
  console.error(`[money-audit] ${operation} was not recorded`, error);
}

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'www.bubaly.com';
  const proto = h.get('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}`;
}

/** Begin (or resume) parent onboarding. Returns a hosted Stripe onboarding URL. */
export async function startConnectOnboardingAction(): Promise<Result<{ url: string }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsCanSetUp') };
  const svc = createServiceClient();
  const caps = await getMoneyCapabilities(svc);
  if (!caps.connectOnboarding) return { ok: false, error: t('actions.paymentsSetupIsNotAvailable') };

  try {
    const { accountId } = await ensureConnectedAccount(svc, {
      familyId: ctx.active.familyId, email: ctx.user.email, userId: ctx.user.id,
    });
    const base = await origin();
    const url = await createOnboardingLink(accountId, {
      returnUrl: `${base}/wallet/cards?setup=complete`,
      refreshUrl: `${base}/wallet/cards?setup=refresh`,
    });
    revalidatePath('/wallet/cards');
    return { ok: true, data: { url } };
  } catch (e) {
    return actionFailure('start Stripe onboarding', e);
  }
}

/** Pull the latest onboarding status from Stripe into our mirror. */
export async function refreshConnectStatusAction(): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsCanDoThis') };
  const svc = createServiceClient();
  const { data: acct, error: acctError } = await svc.from('stripe_connected_accounts')
    .select('stripe_account_id').eq('family_id', ctx.active.familyId).maybeSingle();
  if (acctError) return actionFailure('load the connected account', acctError);
  if (!acct) return { ok: false, error: t('actions.noAccountToRefreshYet') };
  try {
    await syncConnectedAccount(svc, ctx.active.familyId, acct.stripe_account_id);
    revalidatePath('/wallet/cards');
    return { ok: true };
  } catch (e) {
    return actionFailure('refresh Stripe onboarding', e);
  }
}

/** Open the family's Treasury financial account (requires Treasury capability). */
export async function activateTreasuryAction(): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsCanDoThis') };
  const svc = createServiceClient();
  const caps = await getMoneyCapabilities(svc);
  if (!caps.treasury) return { ok: false, error: t('actions.thisFeatureIsNotAvailable') };
  const { data: acct, error: acctError } = await svc.from('stripe_connected_accounts')
    .select('id, stripe_account_id, treasury_enabled').eq('family_id', ctx.active.familyId).maybeSingle();
  if (acctError) return actionFailure('load the Treasury account', acctError);
  if (!acct?.treasury_enabled) return { ok: false, error: t('actions.finishAccountSetupFirst') };
  try {
    await ensureFinancialAccount(svc, {
      familyId: ctx.active.familyId, connectedAccountRowId: acct.id, accountId: acct.stripe_account_id,
    });
    revalidatePath('/wallet/cards');
    return { ok: true };
  } catch (e) {
    return actionFailure('open the Treasury account', e);
  }
}

/** Issue a card for a child (requires Issuing capability). */
export async function issueCardAction(input: {
  childWalletId: string; type: 'virtual' | 'physical'; spendLimitCents: number | null; spendWindow: string;
}): Promise<Result<{ cardId: string }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsCanIssueCards') };
  const svc = createServiceClient();
  const caps = await getMoneyCapabilities(svc);
  if (!caps.issuing) return { ok: false, error: t('actions.cardsAreNotAvailableYet') };
  if (input.type === 'physical' && !caps.physicalCards) return { ok: false, error: t('actions.physicalCardsAreNotAvailable') };

  const [{ data: acct, error: acctError }, { data: wallet, error: walletError }] = await Promise.all([
    svc.from('stripe_connected_accounts').select('stripe_account_id, card_issuing_enabled').eq('family_id', ctx.active.familyId).maybeSingle(),
    svc.from('child_wallets').select('id, member_id').eq('family_id', ctx.active.familyId).eq('id', input.childWalletId).maybeSingle(),
  ]);
  if (acctError) return actionFailure('load card-issuing capabilities', acctError);
  if (walletError) return actionFailure('load the child wallet', walletError);
  if (!acct?.card_issuing_enabled) return { ok: false, error: t('actions.finishAccountSetupFirst') };
  if (!wallet) return { ok: false, error: t('actions.childWalletNotFound') };

  // Trust Engine governs issuing a payment instrument (Trust TODO #1).
  const { decision } = await evaluateTrust(svc, ctx.active.familyId, {
    actor: { kind: 'member', id: ctx.active.member.id, role: roleOf(ctx.active.role) },
    domain: 'finances', capability: 'create',
    title: `Issue ${input.type} card`,
    context: { amountCents: input.spendLimitCents ?? undefined }, openApproval: false,
  });
  if (decision.effect === 'deny') return { ok: false, error: `Blocked by household policy: ${decision.reason}` };

  const { data: member, error: memberError } = await svc.from('family_members').select('display_name').eq('id', wallet.member_id).maybeSingle();
  if (memberError) return actionFailure('load the cardholder profile', memberError);

  try {
    const { rowId: cardholderRowId, stripeCardholderId } = await ensureCardholder(svc, {
      familyId: ctx.active.familyId, memberId: wallet.member_id, childWalletId: wallet.id,
      name: member?.display_name ?? 'Child', accountId: acct.stripe_account_id, userId: ctx.user.id,
    });
    const { rowId } = await issueCard(svc, {
      familyId: ctx.active.familyId, childWalletId: wallet.id, cardholderRowId, stripeCardholderId,
      accountId: acct.stripe_account_id, type: input.type,
      spendLimitCents: input.spendLimitCents, spendWindow: input.spendWindow, userId: ctx.user.id,
    });
    const { error: auditError } = await svc.from('wallet_audit_logs').insert({
      family_id: ctx.active.familyId, actor_user_id: ctx.user.id, action: 'card_issued',
      entity_type: 'stripe_issuing_cards', entity_id: rowId, detail: `${input.type} card issued`,
    });
    if (auditError) logAuditFailure('card issuance', auditError);
    revalidatePath('/wallet');
    return { ok: true, data: { cardId: rowId } };
  } catch (e) {
    return actionFailure('issue the card', e);
  }
}

/** Freeze or unfreeze a child's card. */
export async function setCardFrozenAction(input: { cardId: string; frozen: boolean }): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsCanDoThis') };
  const svc = createServiceClient();
  const { data: card, error: cardError } = await svc.from('stripe_issuing_cards')
    .select('id, stripe_card_id').eq('family_id', ctx.active.familyId).eq('id', input.cardId).maybeSingle();
  if (cardError) return actionFailure('load the card', cardError);
  if (!card) return { ok: false, error: t('actions.cardNotFound') };
  const { data: acct, error: acctError } = await svc.from('stripe_connected_accounts')
    .select('stripe_account_id').eq('family_id', ctx.active.familyId).maybeSingle();
  if (acctError) return actionFailure('load the connected account', acctError);
  if (!acct) return { ok: false, error: t('actions.noAccountConfigured') };
  try {
    await setCardFrozen(svc, {
      familyId: ctx.active.familyId, cardRowId: card.id, stripeCardId: card.stripe_card_id,
      accountId: acct.stripe_account_id, frozen: input.frozen,
    });
    const { error: auditError } = await svc.from('wallet_audit_logs').insert({
      family_id: ctx.active.familyId, actor_user_id: ctx.user.id, action: input.frozen ? 'card_frozen' : 'card_unfrozen',
      entity_type: 'stripe_issuing_cards', entity_id: card.id,
    });
    if (auditError) logAuditFailure('card freeze change', auditError);
    revalidatePath('/wallet');
    return { ok: true };
  } catch (e) {
    return actionFailure('update the card', e);
  }
}

/** Update a card's spending controls: limit + window + blocked categories. */
export async function updateCardControlsAction(input: {
  cardId: string; spendLimitCents: number | null; spendWindow: string; blockedCategories: string[];
}): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsCanSetSpending') };
  const svc = createServiceClient();
  const caps = await getMoneyCapabilities(svc);
  if (!caps.issuing) return { ok: false, error: t('actions.cardsAreNotAvailableYet') };

  const { data: card, error: cardError } = await svc.from('stripe_issuing_cards')
    .select('id, stripe_card_id').eq('family_id', ctx.active.familyId).eq('id', input.cardId).maybeSingle();
  if (cardError) return actionFailure('load the card', cardError);
  if (!card) return { ok: false, error: t('actions.cardNotFound') };
  const { data: acct, error: acctError } = await svc.from('stripe_connected_accounts')
    .select('stripe_account_id').eq('family_id', ctx.active.familyId).maybeSingle();
  if (acctError) return actionFailure('load the connected account', acctError);
  if (!acct) return { ok: false, error: t('actions.noAccountConfigured') };

  // Normalize all inputs server-side so a bad client can't set out-of-range values.
  const spendLimitCents = clampSpendLimitCents(input.spendLimitCents);
  const spendWindow = normalizeSpendWindow(input.spendWindow);
  const blockedCategories = normalizeBlockedCategories(input.blockedCategories);

  try {
    await updateCardControls(svc, {
      familyId: ctx.active.familyId, cardRowId: card.id, stripeCardId: card.stripe_card_id,
      accountId: acct.stripe_account_id, spendLimitCents, spendWindow, blockedCategories,
    });
    const { error: auditError } = await svc.from('wallet_audit_logs').insert({
      family_id: ctx.active.familyId, actor_user_id: ctx.user.id, action: 'card_controls_updated',
      entity_type: 'stripe_issuing_cards', entity_id: card.id,
      metadata: { spendLimitCents, spendWindow, blockedCount: blockedCategories.length },
    });
    if (auditError) logAuditFailure('card controls update', auditError);
    revalidatePath('/wallet');
    return { ok: true };
  } catch (e) {
    return actionFailure('update card controls', e);
  }
}

/**
 * Create an ephemeral key so the parent can REVEAL a card's full number/CVC in
 * the browser via Stripe.js Issuing Elements — the PAN never touches our
 * servers or database (PCI stays with Stripe). The client first calls
 * stripe.createEphemeralKeyNonce({ issuingCard }) and passes the nonce here;
 * the returned secret is single-use and short-lived.
 */
export async function createCardRevealAction(input: {
  cardId: string; nonce: string;
}): Promise<Result<{ ephemeralKeySecret: string; stripeCardId: string; publishableKey: string; stripeAccount: string }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsCanRevealCard') };
  const svc = createServiceClient();
  const caps = await getMoneyCapabilities(svc);
  if (!caps.issuing) return { ok: false, error: t('actions.cardsAreNotAvailableYet') };
  if (!input.nonce?.trim()) return { ok: false, error: t('actions.missingRevealSession') };

  const [{ data: card, error: cardError }, { data: acct, error: acctError }] = await Promise.all([
    svc.from('stripe_issuing_cards').select('id, stripe_card_id')
      .eq('family_id', ctx.active.familyId).eq('id', input.cardId).maybeSingle(),
    svc.from('stripe_connected_accounts').select('stripe_account_id')
      .eq('family_id', ctx.active.familyId).maybeSingle(),
  ]);
  if (cardError) return actionFailure('load the card', cardError);
  if (acctError) return actionFailure('load the connected account', acctError);
  if (!card) return { ok: false, error: t('actions.cardNotFound') };
  if (!acct) return { ok: false, error: t('actions.noAccountConfigured') };

  const publishableKey = effectivePublishableKey(null);
  if (!publishableKey) return { ok: false, error: t('actions.cardRevealIsNotConfigured') };

  try {
    const key = await getStripe().ephemeralKeys.create(
      { issuing_card: card.stripe_card_id, nonce: input.nonce },
      { apiVersion: '2026-05-27.dahlia', stripeAccount: acct.stripe_account_id },
    );
    const { error: auditError } = await svc.from('wallet_audit_logs').insert({
      family_id: ctx.active.familyId, actor_user_id: ctx.user.id, action: 'card_revealed',
      entity_type: 'stripe_issuing_cards', entity_id: card.id,
    });
    if (auditError) logAuditFailure('card reveal', auditError);
    return {
      ok: true,
      data: {
        ephemeralKeySecret: key.secret ?? '',
        stripeCardId: card.stripe_card_id,
        publishableKey,
        stripeAccount: acct.stripe_account_id,
      },
    };
  } catch (e) {
    return actionFailure('start the card reveal session', e);
  }
}

/**
 * Step 1 of the reveal flow: the client needs the Stripe card id + publishable
 * key + connected account BEFORE it can mint the ephemeral-key nonce. No Stripe
 * call happens here — just family-scoped, manager-gated lookups.
 */
export async function prepareCardRevealAction(cardId: string):
  Promise<Result<{ stripeCardId: string; publishableKey: string; stripeAccount: string }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsCanRevealCard') };
  const svc = createServiceClient();
  const caps = await getMoneyCapabilities(svc);
  if (!caps.issuing) return { ok: false, error: t('actions.cardsAreNotAvailableYet') };

  const [{ data: card }, { data: acct }] = await Promise.all([
    svc.from('stripe_issuing_cards').select('stripe_card_id')
      .eq('family_id', ctx.active.familyId).eq('id', cardId).maybeSingle(),
    svc.from('stripe_connected_accounts').select('stripe_account_id')
      .eq('family_id', ctx.active.familyId).maybeSingle(),
  ]);
  if (!card) return { ok: false, error: t('actions.cardNotFound') };
  if (!acct) return { ok: false, error: t('actions.noAccountConfigured') };
  const publishableKey = effectivePublishableKey(null);
  if (!publishableKey) return { ok: false, error: t('actions.cardRevealIsNotConfigured') };

  return { ok: true, data: { stripeCardId: card.stripe_card_id, publishableKey, stripeAccount: acct.stripe_account_id } };
}
