import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { planLevel } from '@/lib/constants/plans';

/**
 * The family's effective subscription level (0 Free / 1 Basic / 2 Plus),
 * resolved robustly across MULTIPLE subscription rows.
 *
 * Why this exists: a family can legitimately have more than one active/trialing
 * subscription row — the `handle_new_family` trigger seeds a free `trialing`
 * row at creation, and admin "Set Plan" / Stripe changes add another. The old
 * pattern (`.in('status', ['active','trialing']).maybeSingle()`) ERRORS when
 * more than one row matches, so its `data` came back null and the family was
 * silently treated as Free regardless of what they actually paid for. We instead
 * read all matching rows and take the HIGHEST plan, so the family always gets the
 * tier they're entitled to and a stray duplicate row never downgrades them.
 */
export async function resolveFamilyPlanLevel(
  supabase: SupabaseClient,
  familyId: string,
): Promise<number> {
  const { data } = await supabase
    .from('subscriptions')
    .select('plan, status')
    .eq('family_id', familyId)
    .in('status', ['active', 'trialing']);
  return (data ?? []).reduce((max, s) => Math.max(max, planLevel(s.plan)), 0);
}
