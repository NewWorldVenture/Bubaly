'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { setFeatureTier, resetFeatureTiers } from '@/lib/server/feature-tiers';
import { isFeatureTier } from '@/lib/features/tiers';
import { FEATURE_CATALOG_BY_KEY } from '@/lib/constants/feature-catalog';
import { describeActionError } from '@/lib/supabase/errors';

type ActionResult = { ok: true } | { ok: false; error: string };
type AdminClient = ReturnType<typeof createServiceClient>;
type GuardResult = { supabase: AdminClient } | { ok: false; error: string };

function actionFailure(operation: string, error: unknown): ActionResult {
  console.error(`[tier-features] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

async function guard(): Promise<GuardResult> {
  const t = await getTranslations();
  const user = await getUser();
  if (!user || !(await isSuperAdmin())) return { ok: false, error: t('actions.notAuthorized') };
  return { supabase: createServiceClient() };
}

function revalidate() {
  revalidatePath('/admin/tier-features');
  revalidatePath('/pricing');       // pricing reflects tier changes live
  revalidatePath('/dashboard', 'layout'); // nav gating resolves fresh
}

export async function setFeatureTierAction(key: string, tier: string): Promise<ActionResult> {
  const t = await getTranslations();
  const guarded = await guard();
  if (!('supabase' in guarded)) return guarded;
  if (!FEATURE_CATALOG_BY_KEY[key]) return { ok: false, error: t('actions.chooseAValidFeature') };
  if (!isFeatureTier(tier)) return { ok: false, error: t('actions.chooseAValidTier') };
  try {
    await setFeatureTier(guarded.supabase, key, tier);
  } catch (error) {
    return actionFailure('save that feature tier', error);
  }
  revalidate();
  return { ok: true };
}

export async function resetFeatureTiersAction(): Promise<ActionResult> {
  const guarded = await guard();
  if (!('supabase' in guarded)) return guarded;
  try {
    await resetFeatureTiers(guarded.supabase);
  } catch (error) {
    return actionFailure('reset feature tiers', error);
  }
  revalidate();
  return { ok: true };
}
