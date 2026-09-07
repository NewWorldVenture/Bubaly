'use server';

// Soft account closure. Closing sets families.closed_at — the account locks and
// disappears from active use, but NOTHING is deleted, so the family can reopen
// and pick up exactly where they left off. Parent-only.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/constants/roles';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: true } | { ok: false; error: string };

function actionFailure(operation: string, error: unknown): Result {
  console.error(`[account-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

export async function closeAccountAction(): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isAdmin(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentCanClose') };
  const admin = createServiceClient();
  const { error } = await admin
    .from('families')
    .update({ closed_at: new Date().toISOString() })
    .eq('id', ctx.active.familyId);
  if (error) return actionFailure('close the account', error);
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function reopenAccountAction(): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isAdmin(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentCanReopen') };
  const admin = createServiceClient();
  const { error } = await admin
    .from('families')
    .update({ closed_at: null })
    .eq('id', ctx.active.familyId);
  if (error) return actionFailure('reopen the account', error);
  revalidatePath('/', 'layout');
  return { ok: true };
}
