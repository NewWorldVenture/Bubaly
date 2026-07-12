// lib/server/entitlement.ts — the 5-day-trial + paywall entitlement model.
//
// computeEntitlement is PURE (unit-tested). Precedence:
//   super-admin           → full access, never locked
//   closed_at set         → closed (locked; nothing deleted)
//   paid (basic/plus)     → that level, unlocked
//   free, trial_ends_at NULL → GRANDFATHERED existing family (unlocked, level 0)
//   free, within trial    → Family Basic (level 1), inTrial
//   free, trial expired   → LOCKED (must buy Family Basic or Family+)
//
// Grandfathering falls out of the data: only families created after migration
// 0161 carry a trial_ends_at, so existing free families (NULL) are never locked.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { planLevel } from '@/lib/constants/plans';

type DB = SupabaseClient<Database>;

export type Entitlement = {
  effectiveLevel: 0 | 1 | 2; // features usable right now (trial grants 1 = Basic)
  locked: boolean;           // trial expired & unpaid & not grandfathered
  closed: boolean;           // account soft-closed
  inTrial: boolean;
  trialEndsAt: string | null;
};

export function computeEntitlement(input: {
  paidLevel: number;            // max level across active/trialing PAID subscriptions
  trialEndsAt: string | null;   // families.trial_ends_at (NULL = grandfathered)
  closedAt: string | null;      // families.closed_at
  isSuperAdmin?: boolean;
  now?: Date;
}): Entitlement {
  const now = input.now ?? new Date();
  const trialEndsAt = input.trialEndsAt;

  if (input.isSuperAdmin) {
    return { effectiveLevel: 2, locked: false, closed: false, inTrial: false, trialEndsAt };
  }
  if (input.closedAt) {
    return { effectiveLevel: 0, locked: true, closed: true, inTrial: false, trialEndsAt };
  }
  if (input.paidLevel >= 1) {
    const lvl = (input.paidLevel >= 2 ? 2 : 1) as 1 | 2;
    return { effectiveLevel: lvl, locked: false, closed: false, inTrial: false, trialEndsAt };
  }
  // Free tier.
  if (trialEndsAt == null) {
    return { effectiveLevel: 0, locked: false, closed: false, inTrial: false, trialEndsAt: null }; // grandfathered
  }
  const inTrial = now.getTime() < new Date(trialEndsAt).getTime();
  if (inTrial) {
    return { effectiveLevel: 1, locked: false, closed: false, inTrial: true, trialEndsAt };
  }
  return { effectiveLevel: 0, locked: true, closed: false, inTrial: false, trialEndsAt };
}

const UNLOCKED_FALLBACK: Entitlement = {
  effectiveLevel: 0, locked: false, closed: false, inTrial: false, trialEndsAt: null,
};

/**
 * Resolve the signed-in user's active-family entitlement. Fails OPEN (unlocked)
 * on any error / no family / pre-migration DB, so a hiccup never traps a user.
 */
export async function resolveEntitlement(
  supabase: DB, userId: string, opts: { isSuperAdmin?: boolean } = {},
): Promise<Entitlement & { familyId: string | null }> {
  try {
    const { data: members } = await supabase
      .from('family_members').select('family_id').eq('user_id', userId).eq('is_active', true);
    const familyIds = (members ?? []).map((m) => m.family_id);
    if (familyIds.length === 0) return { ...UNLOCKED_FALLBACK, familyId: null };

    const { data: prefs } = await supabase
      .from('user_preferences').select('active_family_id').eq('user_id', userId).maybeSingle();
    const activeId = familyIds.includes(prefs?.active_family_id ?? '')
      ? (prefs!.active_family_id as string) : familyIds[0];

    const [{ data: fam }, { data: subs }] = await Promise.all([
      supabase.from('families').select('trial_ends_at, closed_at').eq('id', activeId).maybeSingle(),
      supabase.from('subscriptions').select('plan, status').eq('family_id', activeId).in('status', ['active', 'trialing']),
    ]);

    const paidLevel = (subs ?? []).reduce((max, s) => Math.max(max, planLevel(s.plan)), 0);
    const ent = computeEntitlement({
      paidLevel,
      trialEndsAt: fam?.trial_ends_at ?? null,
      closedAt: fam?.closed_at ?? null,
      isSuperAdmin: opts.isSuperAdmin,
    });
    return { ...ent, familyId: activeId };
  } catch {
    return { ...UNLOCKED_FALLBACK, familyId: null };
  }
}
