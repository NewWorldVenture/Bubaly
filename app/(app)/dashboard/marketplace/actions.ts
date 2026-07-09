'use server';

// Server actions for Marketplace match intelligence. A match can be dismissed
// (stop suggesting this pair) or marked actioned (the family connected on it).
// Family-scoped via RLS; the update is a no-op if the row isn't the family's.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

type Result = { ok: true } | { ok: false; error: string };

/** Set a match's status: dismissed (hide) or actioned (they connected). */
export async function setMatchStatusAction(id: string, status: 'dismissed' | 'actioned'): Promise<Result> {
  if (!id) return { ok: false, error: 'Invalid match' };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase
    .from('marketplace_matches')
    .update({ status })
    .eq('id', id)
    .eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dashboard/marketplace');
  return { ok: true };
}
