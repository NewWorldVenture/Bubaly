'use server';

// app/(app)/money/actions.ts — Bubaly Money (Stripe Financial Mode) server actions.
//
// Every action is manager-gated, capability-gated (graceful no-op message when
// Stripe mode isn't available), and writes to the service-role-only stripe_*
// tables via the service client. No secrets ever reach the client. All financial
// state changes are mirrored from Stripe, never forged locally.
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { getMoneyCapabilities } from '@/lib/stripe/capabilities';
import { ensureConnectedAccount, createOnboardingLink, syncConnectedAccount } from '@/lib/stripe/connect';
import { ensureFinancialAccount } from '@/lib/stripe/treasury';
import { ensureCardholder, issueCard, setCardFrozen } from '@/lib/stripe/issuing';

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'www.bubaly.com';
  const proto = h.get('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}`;
}

/** Begin (or resume) parent onboarding. Returns a hosted Stripe onboarding URL. */
export async function startConnectOnboardingAction(): Promise<Result<{ url: string }>> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only parents can set up payments.' };
  const svc = createServiceClient();
  const caps = await getMoneyCapabilities(svc);
  if (!caps.connectOnboarding) return { ok: false, error: 'Payments setup is not available yet.' };

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
    return { ok: false, error: e instanceof Error ? e.message : 'Could not start onboarding.' };
  }
}

/** Pull the latest onboarding status from Stripe into our mirror. */
export async function refreshConnectStatusAction(): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only parents can do this.' };
  const svc = createServiceClient();
  const { data: acct } = await svc.from('stripe_connected_accounts')
    .select('stripe_account_id').eq('family_id', ctx.active.familyId).maybeSingle();
  if (!acct) return { ok: false, error: 'No account to refresh yet.' };
  try {
    await syncConnectedAccount(svc, ctx.active.familyId, acct.stripe_account_id);
    revalidatePath('/wallet/cards');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not refresh status.' };
  }
}

/** Open the family's Treasury financial account (requires Treasury capability). */
export async function activateTreasuryAction(): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only parents can do this.' };
  const svc = createServiceClient();
  const caps = await getMoneyCapabilities(svc);
  if (!caps.treasury) return { ok: false, error: 'This feature is not available yet.' };
  const { data: acct } = await svc.from('stripe_connected_accounts')
    .select('id, stripe_account_id, treasury_enabled').eq('family_id', ctx.active.familyId).maybeSingle();
  if (!acct?.treasury_enabled) return { ok: false, error: 'Finish account setup first.' };
  try {
    await ensureFinancialAccount(svc, {
      familyId: ctx.active.familyId, connectedAccountRowId: acct.id, accountId: acct.stripe_account_id,
    });
    revalidatePath('/wallet/cards');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not open the account.' };
  }
}

/** Issue a card for a child (requires Issuing capability). */
export async function issueCardAction(input: {
  childWalletId: string; type: 'virtual' | 'physical'; spendLimitCents: number | null; spendWindow: string;
}): Promise<Result<{ cardId: string }>> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only parents can issue cards.' };
  const svc = createServiceClient();
  const caps = await getMoneyCapabilities(svc);
  if (!caps.issuing) return { ok: false, error: 'Cards are not available yet.' };
  if (input.type === 'physical' && !caps.physicalCards) return { ok: false, error: 'Physical cards are not available yet.' };

  const [{ data: acct }, { data: wallet }] = await Promise.all([
    svc.from('stripe_connected_accounts').select('stripe_account_id, card_issuing_enabled').eq('family_id', ctx.active.familyId).maybeSingle(),
    svc.from('child_wallets').select('id, member_id').eq('family_id', ctx.active.familyId).eq('id', input.childWalletId).maybeSingle(),
  ]);
  if (!acct?.card_issuing_enabled) return { ok: false, error: 'Finish account setup first.' };
  if (!wallet) return { ok: false, error: 'Child wallet not found.' };
  const { data: member } = await svc.from('family_members').select('display_name').eq('id', wallet.member_id).maybeSingle();

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
    await svc.from('wallet_audit_logs').insert({
      family_id: ctx.active.familyId, actor_user_id: ctx.user.id, action: 'card_issued',
      entity_type: 'stripe_issuing_cards', entity_id: rowId, detail: `${input.type} card issued`,
    });
    revalidatePath('/wallet');
    return { ok: true, data: { cardId: rowId } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not issue the card.' };
  }
}

/** Freeze or unfreeze a child's card. */
export async function setCardFrozenAction(input: { cardId: string; frozen: boolean }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only parents can do this.' };
  const svc = createServiceClient();
  const { data: card } = await svc.from('stripe_issuing_cards')
    .select('id, stripe_card_id').eq('family_id', ctx.active.familyId).eq('id', input.cardId).maybeSingle();
  if (!card) return { ok: false, error: 'Card not found.' };
  const { data: acct } = await svc.from('stripe_connected_accounts')
    .select('stripe_account_id').eq('family_id', ctx.active.familyId).maybeSingle();
  if (!acct) return { ok: false, error: 'No account configured.' };
  try {
    await setCardFrozen(svc, {
      familyId: ctx.active.familyId, cardRowId: card.id, stripeCardId: card.stripe_card_id,
      accountId: acct.stripe_account_id, frozen: input.frozen,
    });
    await svc.from('wallet_audit_logs').insert({
      family_id: ctx.active.familyId, actor_user_id: ctx.user.id, action: input.frozen ? 'card_frozen' : 'card_unfrozen',
      entity_type: 'stripe_issuing_cards', entity_id: card.id,
    });
    revalidatePath('/wallet');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not update the card.' };
  }
}
