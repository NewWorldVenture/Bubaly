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
import { settleAll } from '@/lib/supabase/settle';
import { stripeFromKey } from '@/lib/stripe';
import { getStripeSettings, effectiveSecretKey } from '@/lib/stripe/settings';
import { canChangeSubscriptionInPlace } from '@/lib/billing/plans';
import { otherLiveFamilySubscriptions } from '@/lib/billing/one-subscription';

type Result = { ok: true } | { ok: false; error: string };

function actionFailure(operation: string, message: string, error: unknown): Result {
  console.error(`[account-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

/**
 * Stop every subscription that bills this family from renewing, before the
 * account is closed. A closed family is locked out entirely
 * (lib/server/entitlement.ts), and closing used to leave the Stripe
 * subscription renewing: a family billed every period for an account it could
 * not use. Renewal stops at the end of the period already paid for; nothing is
 * cancelled immediately or refunded. False when it could not be done, so the
 * account is not closed while it would still bill.
 */
async function stopRenewals(admin: ReturnType<typeof createServiceClient>, familyId: string): Promise<boolean> {
  const [{ data: sub, error: subError }, { data: bc, error: bcError }] = await settleAll([
    admin.from('subscriptions').select('provider_ref, status, cancel_at_period_end').eq('family_id', familyId).maybeSingle(),
    admin.from('billing_customers').select('customer_ref').eq('family_id', familyId).maybeSingle(),
  ]);
  if (subError || bcError) {
    console.error('[account-action] billing state read failed before closing', subError ?? bcError);
    return false;
  }
  const live = canChangeSubscriptionInPlace(sub) ? sub : null;
  // Never billed: no subscription to stop and no customer to look under.
  if (!live && !bc?.customer_ref) return true;
  const secretKey = effectiveSecretKey(await getStripeSettings());
  if (!secretKey) {
    if (!live) return true;
    console.error('[account-action] a billed family cannot be closed: no Stripe key to stop the renewal', { familyId });
    return false;
  }
  try {
    const stripe = stripeFromKey(secretKey);
    let customer: string | undefined;
    if (live && !live.cancel_at_period_end) {
      const updated = await stripe.subscriptions.update(live.provider_ref, { cancel_at_period_end: true });
      customer = typeof updated.customer === 'string' ? updated.customer : updated.customer?.id;
    }
    const others = await otherLiveFamilySubscriptions(stripe, [customer, bc?.customer_ref], familyId, live?.provider_ref ?? '');
    for (const id of others) await stripe.subscriptions.update(id, { cancel_at_period_end: true });
    if (live && !live.cancel_at_period_end) {
      // Optimistic; the subscription webhook confirms it either way.
      const { error: syncError } = await admin.from('subscriptions')
        .update({ cancel_at_period_end: true }).eq('family_id', familyId).select('id');
      if (syncError) console.error('[account-action] renewal stopped in Stripe but not mirrored locally', syncError);
    }
    return true;
  } catch (error) {
    console.error('[account-action] could not stop the plan renewing before closing', error);
    return false;
  }
}

export async function closeAccountAction(): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isAdmin(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentCanClose') };
  const admin = createServiceClient();
  if (!(await stopRenewals(admin, ctx.active.familyId))) return { ok: false, error: t('account.couldNotStopThePlanRenewing') };
  // Closing an account has retention and billing consequences the family is
  // entitled to believe happened. A no-op reported as success is a promise
  // about their data that nothing kept. Audit C1-S9-51.
  const { data: closed, error } = await admin
    .from('families')
    .update({ closed_at: new Date().toISOString() })
    .eq('id', ctx.active.familyId).select('id');
  if (error) return actionFailure('close the account', t('account.couldNotCloseTheAccount'), error);
  if (wroteNoRows(closed)) return { ok: false, error: t('account.couldNotCloseTheAccount') };
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
