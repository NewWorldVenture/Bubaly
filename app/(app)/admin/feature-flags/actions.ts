'use server';

import { revalidatePath } from 'next/cache';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';

type Result = { ok: true } | { ok: false; error: string };

async function guard() {
  const user = await getUser();
  if (!user || !(await isSuperAdmin())) throw new Error('Forbidden: admin only');
  return createServiceClient();
}

/**
 * Toggle a global feature flag. feature_flags has authenticated SELECT but no
 * write policy, so writes go through the service-role client (super-admin only)
 * — replacing the old "toggle it in the database" workflow with one in-app tap.
 */
export async function setFeatureFlagAction(input: { key: string; enabled: boolean }): Promise<Result> {
  const supabase = await guard();
  const key = input.key.trim();
  if (!key) return { ok: false, error: 'Missing flag key.' };

  const { error } = await supabase
    .from('feature_flags')
    .upsert({ key, enabled: input.enabled }, { onConflict: 'key' });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/admin/feature-flags');
  revalidatePath('/admin/stripe');
  return { ok: true };
}
