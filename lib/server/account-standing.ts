import 'server-only';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getTranslations } from '@/lib/i18n/server';
import { lockedEntitlementCode } from '@/lib/server/entitlement';
import { resolveFamilyEntitlement } from '@/lib/server/plan';
import { isSuperAdmin } from '@/lib/supabase/auth';

type DB = SupabaseClient<Database>;
export type LockedCode = NonNullable<ReturnType<typeof lockedEntitlementCode>>;

/**
 * Is this family's account closed ('account_closed'), or past an unpaid trial
 * ('trial_expired')? Null when it is neither.
 *
 * The one read behind `refuseClosedOrTrialEnded`, for a caller that answers the
 * refusal in its own words (the public gift page speaks to a giver, not to the
 * family). THROWS when the family cannot be read, exactly as
 * `resolveFamilyEntitlement` does: an unreadable account is not a closed one.
 */
export async function familyLockedCode(db: DB, familyId: string): Promise<LockedCode | null> {
  return lockedEntitlementCode(await resolveFamilyEntitlement(db, familyId));
}

/**
 * Refuses a closed or trial-ended family before a route spends anything on it.
 *
 * For the routes with no feature gate of their own: the Free-tier AI helpers
 * (habits, journal, notes, the relationship helper) and voice.
 * Each calls a model or a voice provider on the deployment's keys, and none
 * asked whether the account was open, so the paywall `app/(app)/layout.tsx`
 * draws over the web screens was the only thing in a locked family's way, and
 * the phone app has no paywall at all. A route that already runs
 * `refuseUnlessEntitled` or `assertAIAccess` does not need this: both refuse a
 * locked family themselves, with the same codes.
 *
 * Refusal only. Metering these routes is a separate question with its own
 * owner, and nothing here counts or records a request.
 *
 * `db` is the request's own client: a refused caller who is a super
 * administrator passes, as every other gate lets them preview. Returns null to
 * proceed; a 403 shaped like `refuseUnlessEntitled`'s locked refusal
 * (`code`, `needLevel` 1) to refuse; a 503 when the family cannot be read.
 */
export async function refuseClosedOrTrialEnded(db: DB, familyId: string): Promise<NextResponse | null> {
  let code: LockedCode | null;
  try {
    code = await familyLockedCode(db, familyId);
    if (code && (await isSuperAdmin(db))) return null;
  } catch (error) {
    console.error('[account-standing] family standing read failed', { familyId, error });
    const t = await getTranslations();
    return NextResponse.json({ error: t('accountStanding.unavailable'), code: 'unavailable' }, { status: 503 });
  }
  if (!code) return null;
  const t = await getTranslations();
  return NextResponse.json(
    { error: t(code === 'account_closed' ? 'accountStanding.accountClosed' : 'accountStanding.trialEnded'), code, needLevel: 1 },
    { status: 403 },
  );
}
