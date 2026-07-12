'use server';

// Soft account closure. Closing sets families.closed_at — the account locks and
// disappears from active use, but NOTHING is deleted, so the family can reopen
// and pick up exactly where they left off. Parent-only.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/constants/roles';

type Result = { ok: true } | { ok: false; error: string };

export async function closeAccountAction(): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isAdmin(ctx.active.role)) return { ok: false, error: 'Only a parent can close the account.' };
  const admin = createServiceClient();
  const { error } = await admin
    .from('families')
    .update({ closed_at: new Date().toISOString() })
    .eq('id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function reopenAccountAction(): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isAdmin(ctx.active.role)) return { ok: false, error: 'Only a parent can reopen the account.' };
  const admin = createServiceClient();
  const { error } = await admin
    .from('families')
    .update({ closed_at: null })
    .eq('id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/', 'layout');
  return { ok: true };
}
