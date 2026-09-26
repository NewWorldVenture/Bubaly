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

type Result = { ok: true } | { ok: false; error: string };

function actionFailure(operation: string, message: string, error: unknown): Result {
  console.error(`[account-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

export async function closeAccountAction(): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isAdmin(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentCanClose') };
  const admin = createServiceClient();
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
