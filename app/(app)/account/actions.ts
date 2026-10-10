'use server';

// Soft account closure. Closing sets families.closed_at — the account locks and
// disappears from active use, but NOTHING is deleted, so the family can reopen
// and pick up exactly where they left off. Parent-only.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/constants/roles';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { stripeFromKey } from '@/lib/stripe';
import { getStripeSettings, effectiveSecretKey } from '@/lib/stripe/settings';

type Result = { ok: true; notice?: string } | { ok: false; error: string };

/** Statuses Stripe can still bill. A canceled or expired subscription has nothing left to stop. */
const BILLABLE_STATUSES = new Set(['trialing', 'active', 'past_due', 'incomplete', 'unpaid']);

/**
 * How far before `closed_at` a Stripe cancel may have been made and still be
 * the close's own. closeAccountAction asks Stripe first and stamps `closed_at`
 * only after every cancel has answered, so the close's cancels sit just before
 * the stamp; the slack after it absorbs clock skew between Stripe and us.
 */
const CLOSE_CANCEL_WINDOW_BEFORE_MS = 2 * 60_000;
const CLOSE_CANCEL_WINDOW_AFTER_MS = 60_000;

function actionFailure(operation: string, message: string, error: unknown): Result {
  console.error(`[account-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

export async function closeAccountAction(): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isAdmin(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentCanClose') };
  const admin = createServiceClient();
  const familyId = ctx.active.familyId;

  // Closing stops the billing too, the way the billing page's cancel does
  // (app/api/billing/cancel/route.ts): every subscription Stripe can still bill
  // is set to end at its period end. Only setting `closed_at` left the family
  // paying for an account they had closed. Stripe is asked FIRST, and a cancel
  // that cannot be made refuses the close — a closed account still billing is
  // exactly what the family must not be told did not happen.
  const { data: subs, error: subsError } = await admin
    .from('subscriptions')
    .select('id, provider_ref, status, cancel_at_period_end')
    .eq('family_id', familyId);
  if (subsError) return actionFailure('read the subscription before closing', t('account.couldNotCloseTheAccount'), subsError);
  const billable = (subs ?? []).filter((s) => s.provider_ref && BILLABLE_STATUSES.has(s.status) && !s.cancel_at_period_end);
  const cancelled: { id: string; provider_ref: string }[] = [];
  let stripe: ReturnType<typeof stripeFromKey> | null = null;
  if (billable.length) {
    const secretKey = effectiveSecretKey(await getStripeSettings());
    if (!secretKey) return actionFailure('cancel billing before closing', t('account.couldNotCloseTheAccount'), 'billing is not set up');
    stripe = stripeFromKey(secretKey);
  }
  // Undo what this attempt did to Stripe, so a refused close leaves billing as
  // it was. Answers whether every subscription was resumed: one that was not is
  // still set to end, and the refusal the family reads has to say so — a log
  // line alone left them believing nothing about their billing had changed.
  const resumeCancelled = async (): Promise<boolean> => {
    let resumedAll = true;
    for (const s of cancelled) {
      try {
        await stripe!.subscriptions.update(s.provider_ref, { cancel_at_period_end: false });
      } catch (e) {
        resumedAll = false;
        console.error('[account-action] could not resume a subscription after a refused close', { subscriptionId: s.id, error: e });
        continue;
      }
      // Stripe — the thing that bills — is resumed; the webhook reconciles a
      // local row this write misses. Read back for the log: a row it did not
      // reach is a billing page out of step until the webhook lands.
      const { data: synced, error: syncError } = await admin.from('subscriptions').update({ cancel_at_period_end: false }).eq('id', s.id).select('id');
      if (syncError || wroteNoRows(synced)) console.error('[account-action] subscription sync write failed after resume', { subscriptionId: s.id, error: syncError ?? 'no rows updated' });
    }
    return resumedAll;
  };
  const refuse = async (operation: string, error: unknown): Promise<Result> => {
    const resumedAll = await resumeCancelled();
    const failure = actionFailure(operation, t('account.couldNotCloseTheAccount'), error);
    if (resumedAll || failure.ok) return failure;
    return { ok: false, error: `${failure.error} ${t('account.yourSubscriptionIsStillSetToEnd')}` };
  };
  for (const s of billable) {
    try {
      await stripe!.subscriptions.update(s.provider_ref!, { cancel_at_period_end: true });
    } catch (e) {
      return refuse('cancel billing before closing', e);
    }
    cancelled.push({ id: s.id, provider_ref: s.provider_ref! });
    // The webhook reconciles the local row as well; this keeps the billing page
    // honest in the meantime. A failed sync is logged, not fatal: Stripe — the
    // thing that bills — has already changed. Read back for the same log.
    const { data: synced, error: syncError } = await admin.from('subscriptions').update({ cancel_at_period_end: true }).eq('id', s.id).select('id');
    if (syncError || wroteNoRows(synced)) console.error('[account-action] subscription sync write failed after cancel', { subscriptionId: s.id, error: syncError ?? 'no rows updated' });
  }

  // Closing an account has retention and billing consequences the family is
  // entitled to believe happened. A no-op reported as success is a promise
  // about their data that nothing kept. Audit C1-S9-51.
  const { data: closed, error } = await admin
    .from('families')
    .update({ closed_at: new Date().toISOString() })
    .eq('id', familyId).select('id');
  if (error) return refuse('close the account', error);
  if (wroteNoRows(closed)) return refuse('close the account', 'no family row was updated');
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function reopenAccountAction(): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isAdmin(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentCanReopen') };
  const admin = createServiceClient();
  const familyId = ctx.active.familyId;
  // When it closed: the window that tells the close's own cancels apart from a
  // cancel the family made on the billing page before closing.
  const { data: family, error: familyError } = await admin
    .from('families').select('closed_at').eq('id', familyId).maybeSingle();
  if (familyError) return actionFailure('read the account before reopening', t('account.couldNotReopenTheAccount'), familyError);
  // The mirror image, and it contradicts itself on screen: `resolveEntitlement`
  // in `app/(app)/layout.tsx` reads `closed_at` to decide whether to show
  // `AccountClosedGate`, and this revalidates the whole layout — so a no-op
  // told the family they were reopened and then put the closed-account gate
  // straight back in front of them.
  const { data: reopened, error } = await admin
    .from('families')
    .update({ closed_at: null })
    .eq('id', familyId).select('id');
  if (error) return actionFailure('reopen the account', t('account.couldNotReopenTheAccount'), error);
  if (wroteNoRows(reopened)) return { ok: false, error: t('account.couldNotReopenTheAccount') };
  revalidatePath('/', 'layout');
  // The account is open either way; billing is resumed second and reported, so
  // a Stripe hiccup cannot keep the family locked out of their own data.
  const resumed = await resumeSubscriptionsTheCloseCancelled(admin, familyId, family?.closed_at ?? null);
  return resumed ? { ok: true } : { ok: true, notice: t('account.yourSubscriptionIsStillSetToEnd') };
}

/**
 * Closing set every billable subscription to end at its period end, and
 * reopening undoes that — but only for the subscriptions the close itself
 * cancelled. Closing does not record which ones those were, so a subscription
 * counts as the close's when Stripe says its cancel was requested
 * (`canceled_at`) within the close: shortly before `closed_at`. A cancel the
 * family made on the billing page earlier was their own choice and is left.
 *
 * Answers whether billing is back as it was. False — a cancel-at-period-end
 * subscription is left that the family may want to keep, or one could not be
 * checked or resumed — and the family is told to resume it from billing.
 */
async function resumeSubscriptionsTheCloseCancelled(
  admin: ReturnType<typeof createServiceClient>,
  familyId: string,
  closedAt: string | null,
): Promise<boolean> {
  const { data: subs, error } = await admin
    .from('subscriptions')
    .select('id, provider_ref, status, cancel_at_period_end')
    .eq('family_id', familyId);
  if (error) {
    console.error('[account-action] could not read subscriptions after reopening', error);
    return false;
  }
  const ending = (subs ?? []).filter((s) => s.provider_ref && BILLABLE_STATUSES.has(s.status) && s.cancel_at_period_end);
  if (!ending.length) return true;
  const closedMs = closedAt ? Date.parse(closedAt) : Number.NaN;
  if (Number.isNaN(closedMs)) return false;
  const secretKey = effectiveSecretKey(await getStripeSettings());
  if (!secretKey) return false;
  const stripe = stripeFromKey(secretKey);
  let restored = true;
  for (const s of ending) {
    try {
      const current = await stripe.subscriptions.retrieve(s.provider_ref!);
      const cancelledMs = current.cancel_at_period_end && current.canceled_at ? current.canceled_at * 1000 : Number.NaN;
      const byTheClose = cancelledMs >= closedMs - CLOSE_CANCEL_WINDOW_BEFORE_MS && cancelledMs <= closedMs + CLOSE_CANCEL_WINDOW_AFTER_MS;
      if (!byTheClose) { restored = false; continue; }
      await stripe.subscriptions.update(s.provider_ref!, { cancel_at_period_end: false });
    } catch (e) {
      console.error('[account-action] could not resume a subscription after reopening', { subscriptionId: s.id, error: e });
      restored = false;
      continue;
    }
    // Read back for the log, as above: Stripe has already resumed billing.
    const { data: synced, error: syncError } = await admin.from('subscriptions').update({ cancel_at_period_end: false }).eq('id', s.id).select('id');
    if (syncError || wroteNoRows(synced)) console.error('[account-action] subscription sync write failed after resume', { subscriptionId: s.id, error: syncError ?? 'no rows updated' });
  }
  return restored;
}
