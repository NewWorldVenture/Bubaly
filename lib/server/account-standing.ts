import 'server-only';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getTranslations } from '@/lib/i18n/server';
import { refusedStanding, type RefusedStanding } from '@/lib/server/entitlement';
import { resolveFamilyEntitlement } from '@/lib/server/plan';
import { isSuperAdmin } from '@/lib/supabase/auth';

type DB = SupabaseClient<Database>;

/**
 * What a server gate answers a closed or trial-ended family (see
 * `refusedStanding` in `lib/server/entitlement.ts`), worded once for every gate.
 *
 * Both are 403s. A closed family is told its account is closed, not that it
 * needs a plan, because a plan would not reopen it. A trial-ended family needs
 * a plan, and `needLevel` 1 is the least that unlocks Bubaly again.
 */
export type RefusedStandingDenial = {
  status: 403;
  code: 'account_closed' | 'plan_required';
  needLevel?: number;
  error: string;
};

export async function refusedStandingDenial(standing: RefusedStanding): Promise<RefusedStandingDenial> {
  const t = await getTranslations();
  return standing === 'closed'
    ? { status: 403, code: 'account_closed', error: t('accountStanding.accountClosed') }
    : { status: 403, code: 'plan_required', needLevel: 1, error: t('accountStanding.trialEnded') };
}

/** The same refusal as a route's JSON response. */
export async function refusedStandingResponse(standing: RefusedStanding): Promise<NextResponse> {
  const { status, ...body } = await refusedStandingDenial(standing);
  return NextResponse.json(body, { status });
}

/**
 * Is this family closed, or past an unpaid trial? Null when it is neither.
 *
 * The one read behind `refuseClosedOrTrialEnded`, for a caller that answers
 * the refusal in its own words (the public gift page speaks to a giver, not to
 * the family). THROWS when the family's standing cannot be read, exactly as
 * `resolveFamilyPlanLevel` does: an unreadable account is not a closed one.
 */
export async function familyRefusedStanding(db: DB, familyId: string): Promise<RefusedStanding | null> {
  return refusedStanding(await resolveFamilyEntitlement(db, familyId));
}

/**
 * Refuses a closed or trial-ended family before a route spends anything on it.
 *
 * For the routes with no feature gate of their own: the Free-tier AI helpers
 * (habits, journal, notes, meals, recipes, the pantry chef, the relationship
 * helper) and voice. Each calls a model or a voice provider on the
 * deployment's keys, and none asked whether the account was open, so the
 * paywall `app/(app)/layout.tsx` draws over the web screens was the only thing
 * in a closed or trial-ended family's way. A route that already runs
 * `refuseUnlessEntitled` or `assertAIAccess` does not need this; both ask it.
 *
 * Refusal only. Metering these routes is a separate question with its own
 * owner, and nothing here counts or records a request.
 *
 * `db` is the request's own client: a refused caller who is a super
 * administrator passes, as every other gate lets them preview. Returns null to
 * proceed, a 403 from `refusedStandingResponse` to refuse, or a 503 when the
 * standing cannot be read.
 */
export async function refuseClosedOrTrialEnded(db: DB, familyId: string): Promise<NextResponse | null> {
  let standing: RefusedStanding | null;
  try {
    standing = await familyRefusedStanding(db, familyId);
    if (standing && (await isSuperAdmin(db))) return null;
  } catch (error) {
    console.error('[account-standing] family standing read failed', { familyId, error });
    const t = await getTranslations();
    return NextResponse.json({ error: t('accountStanding.unavailable'), code: 'unavailable' }, { status: 503 });
  }
  return standing ? refusedStandingResponse(standing) : null;
}
