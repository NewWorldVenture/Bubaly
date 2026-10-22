import 'server-only';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { resolveFeatureEntitlement } from '@/lib/server/feature-entitlement';
import { lockedEntitlementCode, resolveFamilyEntitlement } from '@/lib/server/plan';
import { isSuperAdmin } from '@/lib/supabase/auth';

type DB = SupabaseClient<Database>;

/**
 * Refuses a route handler whose feature the family does not have.
 *
 * These endpoints sit behind pages that are `requireFeature`-gated. The page
 * refused; the endpoint behind it did not, so the fetch was the bypass — the
 * same shape as the family @bubaly.com address and the Autopilot cron. Most of
 * them call a model, which is the surface where it costs money per request.
 *
 * `hrefs` is the feature (or features) the endpoint serves; a caller entitled to
 * ANY of them may proceed. Several endpoints are shared by two modules, and
 * requiring both would refuse someone the page in front of them allows.
 *
 * Returns `null` when the request may proceed, or the response to return.
 * Three outcomes, kept distinct on purpose:
 *
 *   404 — every feature it serves is switched off for the whole deployment,
 *         matching the page's `notFound()`.
 *   403 — the family's plan is below it. This is a fact about the family.
 *   503 — the plan could not be READ. This is a fact about Bubaly, and saying
 *         403 here would tell a paying family to buy what they already own.
 */
export async function refuseUnlessEntitled(
  db: DB,
  familyId: string,
  hrefs: readonly string[],
): Promise<NextResponse | null> {
  const outcomes: { reason: 'off' | 'plan' | 'locked'; needLevel: number; code?: 'trial_expired' | 'account_closed' }[] = [];

  for (const href of hrefs) {
    try {
      const entitlement = await resolveFeatureEntitlement(db, familyId, href);
      if (entitlement.allowed) return null;
      outcomes.push({ reason: entitlement.reason, needLevel: entitlement.needLevel, ...(entitlement.reason === 'locked' ? { code: entitlement.code } : {}) });
    } catch (error) {
      console.error('[route-feature-gate] plan read failed', { href, error });
      return NextResponse.json(
        { error: 'Bubaly could not confirm your plan right now. Try again in a moment.', code: 'unavailable' },
        { status: 503 },
      );
    }
  }

  // A super administrator passes, exactly as `requireFeature` lets them onto
  // the page (a feature switched Off included), so previewing a feature works
  // past its first fetch. Before this the page let them in and every endpoint
  // behind it answered 403, and the screens showed that as their own result —
  // Autopilot's "100% the day runs smoothly" over a scan that never ran.
  // Asked only once the family has been refused, so an entitled request pays
  // nothing for it. Audit C1-S9-98.
  try {
    if (await isSuperAdmin(db)) return null;
  } catch (error) {
    console.error('[route-feature-gate] account read failed', { hrefs, error });
    return NextResponse.json(
      { error: 'Bubaly could not confirm your plan right now. Try again in a moment.', code: 'unavailable' },
      { status: 503 },
    );
  }

  if (outcomes.every((o) => o.reason === 'off')) {
    return NextResponse.json({ error: 'Not found.', code: 'feature_off' }, { status: 404 });
  }

  // A trial that ended unpaid (or a closed account) refuses every feature,
  // free ones included: the paywall the layout shows has a server half.
  const locked = outcomes.find((o) => o.reason === 'locked');
  if (locked) {
    return NextResponse.json(
      {
        error: locked.code === 'account_closed'
          ? 'This Bubaly account is closed. Reopen it to continue.'
          : 'Your free trial has ended. Choose Family Basic or Family+ to keep using Bubaly.',
        code: locked.code ?? 'trial_expired',
        needLevel: 1,
      },
      { status: 403 },
    );
  }

  const needLevel = Math.min(...outcomes.filter((o) => o.reason === 'plan').map((o) => o.needLevel));
  return NextResponse.json(
    {
      error: needLevel >= 2
        ? 'This is part of Family+. Upgrade to switch it on for your family.'
        : 'This is part of Family Basic. Upgrade to switch it on for your family.',
      code: 'plan_required',
      needLevel,
    },
    { status: 403 },
  );
}

/**
 * The lock half of `refuseUnlessEntitled`, for an endpoint whose page is not a
 * catalog feature (so it has no tier to be below, and no href the catalog gate
 * test would accept) but is still behind the (app) layout's paywall. A trial
 * that ended unpaid, or a closed account, is refused here as it is on every
 * catalog feature; the overlay is not in front of a fetch. Same three outcomes:
 * `null` to proceed, 403 for a lock, 503 when the state cannot be read.
 */
export async function refuseIfLocked(db: DB, familyId: string): Promise<NextResponse | null> {
  let locked: 'trial_expired' | 'account_closed' | null;
  try {
    locked = lockedEntitlementCode(await resolveFamilyEntitlement(db, familyId));
  } catch (error) {
    console.error('[route-feature-gate] plan read failed', { familyId, error });
    return NextResponse.json(
      { error: 'Bubaly could not confirm your plan right now. Try again in a moment.', code: 'unavailable' },
      { status: 503 },
    );
  }
  if (!locked) return null;
  try {
    if (await isSuperAdmin(db)) return null;
  } catch (error) {
    console.error('[route-feature-gate] account read failed', { familyId, error });
    return NextResponse.json(
      { error: 'Bubaly could not confirm your plan right now. Try again in a moment.', code: 'unavailable' },
      { status: 503 },
    );
  }
  return NextResponse.json(
    {
      error: locked === 'account_closed'
        ? 'This Bubaly account is closed. Reopen it to continue.'
        : 'Your free trial has ended. Choose Family Basic or Family+ to keep using Bubaly.',
      code: locked,
      needLevel: 1,
    },
    { status: 403 },
  );
}
