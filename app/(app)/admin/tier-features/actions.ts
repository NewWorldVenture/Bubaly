'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { superAdminGate } from '@/lib/auth/super-admin-gate';
import { createServiceClient } from '@/lib/supabase/server';
import { setFeatureTier, resetFeatureTiers } from '@/lib/server/feature-tiers';
import { isFeatureTier } from '@/lib/features/tiers';
import { FEATURE_CATALOG_BY_KEY } from '@/lib/constants/feature-catalog';
import { describeActionError } from '@/lib/supabase/errors';
import { logAudit } from '@/lib/server/audit';

type ActionResult = { ok: true } | { ok: false; error: string };
type AdminClient = ReturnType<typeof createServiceClient>;
type GuardResult = { supabase: AdminClient; actorId: string } | { ok: false; error: string };

function actionFailure(operation: string, message: string, error: unknown): ActionResult {
  console.error(`[tier-features] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

async function guard(): Promise<GuardResult> {
  const t = await getTranslations();
  const gate = await superAdminGate();
  if (gate.status !== 'allowed') {
    return { ok: false, error: gate.status === 'unavailable' ? t('ai.accountContextIsTemporarilyUnavailable') : t('actions.notAuthorized') };
  }
  return { supabase: createServiceClient(), actorId: gate.user.id };
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
  let previous: string | null;
  try {
    ({ previous } = await setFeatureTier(guarded.supabase, key, tier, guarded.actorId));
  } catch (error) {
    return actionFailure('save that feature tier', t('tierFeatures.couldNotSaveThatFeatureTier'), error);
  }
  // Platform-wide entitlement gating: who moved which feature, from what.
  await logAudit(guarded.supabase, {
    familyId: null, actorId: guarded.actorId, action: 'update', resource: 'feature_tiers', resourceId: key,
    metadata: { key, previous_tier: previous ?? FEATURE_CATALOG_BY_KEY[key].defaultTier, tier, via: 'site_admin' },
  });
  revalidate();
  return { ok: true };
}

export async function resetFeatureTiersAction(): Promise<ActionResult> {
  const t = await getTranslations();
  const guarded = await guard();
  if (!('supabase' in guarded)) return guarded;
  let previous: Record<string, string>;
  try {
    ({ previous } = await resetFeatureTiers(guarded.supabase, guarded.actorId));
  } catch (error) {
    return actionFailure('reset feature tiers', t('tierFeatures.couldNotResetFeatureTiers'), error);
  }
  await logAudit(guarded.supabase, {
    familyId: null, actorId: guarded.actorId, action: 'reset', resource: 'feature_tiers', resourceId: 'feature_tiers',
    metadata: { previous_overrides: previous, via: 'site_admin' },
  });
  revalidate();
  return { ok: true };
}
