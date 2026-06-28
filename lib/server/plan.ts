import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/server';
import { planLevel } from '@/lib/constants/plans';

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
  _supabase: SupabaseClient,
  familyId: string,
): Promise<number> {
  const admin = createServiceClient();
  const { data } = await admin
    .from('subscriptions')
    .select('plan, status')
    .eq('family_id', familyId)
    .in('status', ['active', 'trialing']);
  return (data ?? []).reduce((max, s) => Math.max(max, planLevel(s.plan)), 0);
}
