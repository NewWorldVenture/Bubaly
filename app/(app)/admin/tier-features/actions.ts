'use server';

import { revalidatePath } from 'next/cache';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { setFeatureTier, resetFeatureTiers } from '@/lib/server/feature-tiers';
import { isFeatureTier } from '@/lib/features/tiers';

async function guard() {
  const user = await getUser();
  if (!user || !(await isSuperAdmin())) throw new Error('Forbidden: admin only');
  return createServiceClient();
}

function revalidate() {
  revalidatePath('/admin/tier-features');
  revalidatePath('/pricing');       // pricing reflects tier changes live
  revalidatePath('/dashboard', 'layout'); // nav gating resolves fresh
}

export async function setFeatureTierAction(key: string, tier: string): Promise<{ ok: boolean }> {
  if (!isFeatureTier(tier)) return { ok: false };
  const supabase = await guard();
  await setFeatureTier(supabase, key, tier);
  revalidate();
  return { ok: true };
}

export async function resetFeatureTiersAction(): Promise<{ ok: boolean }> {
  const supabase = await guard();
  await resetFeatureTiers(supabase);
  revalidate();
  return { ok: true };
}
