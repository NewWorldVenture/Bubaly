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

type Result = { ok: true } | { ok: false; error: string };

/** Statuses Stripe can still bill. A canceled or expired subscription has nothing left to stop. */
const BILLABLE_STATUSES = new Set(['trialing', 'active', 'past_due', 'incomplete', 'unpaid']);

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
  // Undo what this attempt did to Stripe, so a refused close leaves billing as it was.
  const resumeCancelled = async () => {
    for (const s of cancelled) {
      try {
        await stripe!.subscriptions.update(s.provider_ref, { cancel_at_period_end: false });
        await admin.from('subscriptions').update({ cancel_at_period_end: false }).eq('id', s.id);
      } catch (e) {
        console.error('[account-action] could not resume a subscription after a refused close', { subscriptionId: s.id, error: e });
      }
    }
  };
  for (const s of billable) {
    try {
      await stripe!.subscriptions.update(s.provider_ref!, { cancel_at_period_end: true });
    } catch (e) {
      await resumeCancelled();
      return actionFailure('cancel billing before closing', t('account.couldNotCloseTheAccount'), e);
    }
    cancelled.push({ id: s.id, provider_ref: s.provider_ref! });
    // The webhook reconciles the local row as well; this keeps the billing page
    // honest in the meantime. A failed sync is logged, not fatal: Stripe — the
    // thing that bills — has already changed.
    const { error: syncError } = await admin.from('subscriptions').update({ cancel_at_period_end: true }).eq('id', s.id);
    if (syncError) console.error('[account-action] subscription sync write failed after cancel', syncError);
  }

  // Closing an account has retention and billing consequences the family is
  // entitled to believe happened. A no-op reported as success is a promise
  // about their data that nothing kept. Audit C1-S9-51.
  const { data: closed, error } = await admin
    .from('families')
    .update({ closed_at: new Date().toISOString() })
    .eq('id', familyId).select('id');
  if (error) {
    await resumeCancelled();
    return actionFailure('close the account', t('account.couldNotCloseTheAccount'), error);
  }
  if (wroteNoRows(closed)) {
    await resumeCancelled();
    return { ok: false, error: t('account.couldNotCloseTheAccount') };
  }
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function reopenAccountAction(): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isAdmin(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentCanReopen') };
  const admin = createServiceClient();
  // The mirror image, and it contradicts itself on screen: `resolveEntitlement`
  // in `app/(app)/layout.tsx` reads `closed_at` to decide whether to show
  // `AccountClosedGate`, and this revalidates the whole layout — so a no-op
  // told the family they were reopened and then put the closed-account gate
  // straight back in front of them.
  const { data: reopened, error } = await admin
    .from('families')
    .update({ closed_at: null })
    .eq('id', ctx.active.familyId).select('id');
  if (error) return actionFailure('reopen the account', t('account.couldNotReopenTheAccount'), error);
  if (wroteNoRows(reopened)) return { ok: false, error: t('account.couldNotReopenTheAccount') };
  revalidatePath('/', 'layout');
  return { ok: true };
}
