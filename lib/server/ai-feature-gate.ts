import 'server-only';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { resolveFeatureEntitlement } from '@/lib/server/feature-entitlement';

type DB = SupabaseClient<Database>;

/**
 * Refuses a route handler whose feature the family does not have.
 *
 * These endpoints sit behind pages that are `requireFeature`-gated, and each
 * one calls a model. The page refused; the endpoint behind it did not, so the
 * fetch was the bypass — the same shape as the family @bubaly.com address and
 * the Autopilot cron, on a surface that costs money per request.
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
  const outcomes: { reason: 'off' | 'plan'; needLevel: number }[] = [];

  for (const href of hrefs) {
    try {
      const entitlement = await resolveFeatureEntitlement(db, familyId, href);
      if (entitlement.allowed) return null;
      outcomes.push({ reason: entitlement.reason, needLevel: entitlement.needLevel });
    } catch (error) {
      console.error('[ai-feature-gate] plan read failed', { href, error });
      return NextResponse.json(
        { error: 'Bubaly could not confirm your plan right now. Try again in a moment.', code: 'unavailable' },
        { status: 503 },
      );
    }
  }

  if (outcomes.every((o) => o.reason === 'off')) {
    return NextResponse.json({ error: 'Not found.', code: 'feature_off' }, { status: 404 });
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
