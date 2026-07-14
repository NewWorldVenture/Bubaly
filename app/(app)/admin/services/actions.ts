'use server';

import { revalidatePath } from 'next/cache';
import { createServiceClient } from '@/lib/supabase/server';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { describeActionError } from '@/lib/supabase/errors';
import { isKnownServiceKey } from '@/lib/services/descriptions-server';
import { SERVICE_DESCRIPTIONS } from '@/lib/services/descriptions';

type ActionResult = { ok: true } | { ok: false; error: string };

const MAX_LEN = 400;

/**
 * Save (or clear) a super-admin override for one service's tooltip description.
 * An empty value — or a value identical to the shipped default — DELETES the
 * override row so the service falls back to the versioned code default (keeps
 * the table lean and "reset to default" trivial). Super-admin only; writes via
 * the service role (RLS denies client writes).
 */
export async function saveServiceDescriptionAction({ key, description }: { key: string; description: string }): Promise<ActionResult> {
  if (!(await isSuperAdmin())) return { ok: false, error: 'Not authorized.' };
  if (!isKnownServiceKey(key)) return { ok: false, error: 'Unknown service.' };

  const trimmed = (description ?? '').trim().slice(0, MAX_LEN);
  const supabase = createServiceClient();

  try {
    // Empty or same-as-default → remove the override (fall back to the code default).
    if (!trimmed || trimmed === SERVICE_DESCRIPTIONS[key]) {
      const { error } = await supabase.from('service_descriptions').delete().eq('service_key', key);
      if (error) return { ok: false, error: describeActionError(error, 'Could not reset that description.') };
      revalidatePath('/admin/services');
      return { ok: true };
    }

    const updatedBy = (await getUser())?.id ?? null;
    const { error } = await supabase
      .from('service_descriptions')
      .upsert({ service_key: key, description: trimmed, updated_by: updatedBy }, { onConflict: 'service_key' });
    if (error) return { ok: false, error: describeActionError(error, 'Could not save that description.') };
    revalidatePath('/admin/services');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeActionError(error, 'Could not save that description.') };
  }
}

/** Reset one service back to its shipped default (deletes any override). */
export async function resetServiceDescriptionAction({ key }: { key: string }): Promise<ActionResult> {
  return saveServiceDescriptionAction({ key, description: '' });
}
