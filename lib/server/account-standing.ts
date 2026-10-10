import 'server-only';
import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import type { RefusedStanding } from '@/lib/server/entitlement';

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
