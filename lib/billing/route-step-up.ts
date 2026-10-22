// lib/billing/route-step-up.ts — the AAL2 step-up for the billing API routes.
//
// /dashboard/billing calls requireAal2(ctx, 'money'), but the routes it calls
// (portal, cancel, change-plan, checkout) did not, so an aal1 session that the
// page bounced to /auth/step-up could POST them directly: open the Stripe
// portal, schedule a cancellation, change the price. A page guard cannot cover
// an endpoint the page does not have to render to reach — the same gap
// app/(app)/dashboard/billing/actions.ts closes for the money server actions.
import 'server-only';
import { NextResponse } from 'next/server';
import { aal2Verdict } from '@/lib/auth/require-aal2';
import type { UserContext } from '@/lib/supabase/auth';

const BILLING = '/dashboard/billing';

/** `null` when the request may proceed, else the 403 to answer with. */
export async function refuseWithoutBillingStepUp(ctx: UserContext, t: (key: string) => string): Promise<NextResponse | null> {
  const verdict = await aal2Verdict(ctx, 'money', BILLING);
  if (verdict.action !== 'step_up') return null;
  return NextResponse.json(
    { error: t('actions.moneyNeedsYourCodeAgain'), code: 'step_up_required', stepUp: verdict.to },
    { status: 403 },
  );
}
