import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { planLevel } from '@/lib/constants/plans';
import { computeEntitlement, PAID_SUBSCRIPTION_STATUSES, subscriptionGrantsPaidLevel, type Entitlement } from '@/lib/server/entitlement';

export { lockedEntitlementCode } from '@/lib/server/entitlement';

/**
 * The family's effective subscription level (0 Free / 1 Basic / 2 Plus),
 * resolved robustly.
 *
 * Two failure modes this guards against — both observed as "every account shows
 * Free Tier" even when the subscription row is correct:
 *
 *  1. MULTIPLE rows. A family can have >1 active/trialing subscription (the
 *     `handle_new_family` trigger seeds a free `trialing` row; admin "Set Plan" /
 *     Stripe add another). The old `.maybeSingle()` ERRORS on >1 row → null →
 *     Free. We read ALL matching rows and take the HIGHEST plan.
 *
 *  2. RLS read returning empty. The user-scoped client reads `subscriptions`
 *     under the `subs_select` policy (`is_family_member`). If that ever resolves
 *     empty for a legitimate member (snapshot/visibility edge cases), the plan
 *     silently falls back to Free. Reading the family's own plan is a trusted,
 *     server-side gating concern, so we use the SERVICE-ROLE client to bypass RLS
 *     entirely and read the real plan. `familyId` is always the caller's verified
 *     active family.
 *
 * The `supabase` parameter is accepted for call-site symmetry but the read uses
 * the service-role client (see above).
 */
export async function resolveFamilyPlanLevel(
  supabase: SupabaseClient,
  familyId: string,
): Promise<number> {
  return (await resolveFamilyEntitlement(supabase, familyId)).effectiveLevel;
}

/**
 * The family's whole entitlement — level AND `locked`/`closed` — read the same
 * robust way as `resolveFamilyPlanLevel` (which is this, narrowed to its level).
 * A server-side gate needs the lock: a trial-expired family is at level 0 like a
 * free one, but unlike a free one it may use nothing, and the (app) layout's
 * overlay is not in front of an API route, a server action or the mobile app.
 * THROWS when the state cannot be read, exactly as resolveFamilyPlanLevel does.
 */
export async function resolveFamilyEntitlement(
  _supabase: SupabaseClient,
  familyId: string,
): Promise<Entitlement> {
  const admin = createServiceClient();
  const [{ data: subs, error: subscriptionsError }, { data: fam, error: familyError }] = await settleAll([
    admin.from('subscriptions').select('plan, status, current_period_end').eq('family_id', familyId).in('status', [...PAID_SUBSCRIPTION_STATUSES]),
    admin.from('families').select('trial_ends_at, closed_at').eq('id', familyId).maybeSingle(),
  ]);
  if (subscriptionsError || familyError || !fam) {
    console.error('[plan] family entitlement read failed', { subscriptionsError, familyError, familyId, foundFamily: Boolean(fam) });
    throw new Error('Family subscription state is unavailable.');
  }
  const now = new Date();
  // A past_due row counts only within its grace (PAST_DUE_GRACE_MS).
  const paidLevel = (subs ?? []).filter((s) => subscriptionGrantsPaidLevel(s, now))
    .reduce((max, s) => Math.max(max, planLevel(s.plan)), 0);
  // During the 5-day free trial a family gets Family Basic (level 1); existing
  // grandfathered free families (trial_ends_at NULL) stay at their paid level.
  return computeEntitlement({
    paidLevel,
    trialEndsAt: fam?.trial_ends_at ?? null,
    closedAt: fam?.closed_at ?? null,
    now,
  });
}
