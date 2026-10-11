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
import { settleAll } from '@/lib/supabase/settle';
import type { Database } from '@/lib/database.types';
import { planLevel } from '@/lib/constants/plans';
import { chooseActiveMembership } from '@/lib/auth/active-membership';
import { intervalOfSlug } from '@/lib/billing/plans';

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

/**
 * Subscription statuses that carry their plan's level. `past_due` is Stripe's
 * retry window after a failed renewal: the family is still subscribed (checkout
 * refuses them a second subscription, the portal fixes the card), so it keeps
 * its level for a bounded grace while Stripe retries. Locking it at once
 * trapped the family behind a paywall whose only action, checkout, answered
 * "already subscribed"; that paywall now opens the portal on that answer.
 */
export const PAID_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const;

/**
 * How long a `past_due` subscription keeps its paid level after the renewal it
 * failed to pay. Without a limit, a Stripe account set to leave failed
 * subscriptions past_due (or a lost final webhook) granted the paid level
 * forever. After it, the family is treated as unpaid: a trial-era family sees
 * the paywall, whose checkout answers 409 for the still-recorded subscription
 * and sends it to the billing portal to fix the card.
 */
export const PAST_DUE_GRACE_DAYS = 14;
export const PAST_DUE_GRACE_MS = PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000;

/**
 * When a past_due subscription's paid time ran out: the end of the last PAID
 * period. Stripe advances the period when it renews, before the renewal
 * invoice is paid, so a past_due row's `current_period_end` is the end of the
 * UNPAID period; one plan interval before it is the renewal that failed.
 * Anchoring the grace on the stored date itself would have granted an annual
 * plan a year and two weeks without payment. Computed in UTC, so the answer
 * does not move with the server's time zone.
 */
export function pastDuePaidThrough(sub: { plan?: string | null; current_period_end?: string | null }): number | null {
  if (!sub.current_period_end) return null;
  const end = new Date(sub.current_period_end);
  if (!Number.isFinite(end.getTime())) return null;
  const paidThrough = new Date(end.getTime());
  if (intervalOfSlug(sub.plan) === 'annual') paidThrough.setUTCFullYear(paidThrough.getUTCFullYear() - 1);
  else paidThrough.setUTCMonth(paidThrough.getUTCMonth() - 1);
  // Mar 31 minus a month is Feb 31, which Date rolls into March; clamp it to
  // the last day of the shorter month instead (Feb 29 of a leap year likewise).
  if (paidThrough.getUTCDate() !== end.getUTCDate()) paidThrough.setUTCDate(0);
  return paidThrough.getTime();
}

/**
 * Does this subscription row carry its plan's level right now? active and
 * trialing do; past_due does for PAST_DUE_GRACE_MS after the renewal it failed
 * (see pastDuePaidThrough). A past_due row with no readable period end has no
 * grace to give.
 */
export function subscriptionGrantsPaidLevel(
  sub: { status: string; plan?: string | null; current_period_end?: string | null },
  now: Date = new Date(),
): boolean {
  if (sub.status === 'active' || sub.status === 'trialing') return true;
  if (sub.status !== 'past_due') return false;
  const paidThrough = pastDuePaidThrough(sub);
  return paidThrough !== null && now.getTime() < paidThrough + PAST_DUE_GRACE_MS;
}

/** The refusal code for a locked entitlement, or null when it is not locked. */
export function lockedEntitlementCode(entitlement: Pick<Entitlement, 'locked' | 'closed'>): 'trial_expired' | 'account_closed' | null {
  if (entitlement.closed) return 'account_closed';
  return entitlement.locked ? 'trial_expired' : null;
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
      .from('family_members').select('family_id, created_at').eq('user_id', userId).eq('is_active', true);
    if (!members?.length) return { ...UNLOCKED_FALLBACK, familyId: null };

    const { data: prefs } = await supabase
      .from('user_preferences').select('active_family_id').eq('user_id', userId).maybeSingle();
    // The same choice getUserContext makes, so the gate judges the family the
    // page is about to show.
    const activeId = chooseActiveMembership(members, prefs?.active_family_id)!.family_id;

    const [{ data: fam, error: familyError }, { data: subs, error: subscriptionsError }] = await settleAll([
      supabase.from('families').select('trial_ends_at, closed_at').eq('id', activeId).maybeSingle(),
      supabase.from('subscriptions').select('plan, status, current_period_end').eq('family_id', activeId).in('status', [...PAID_SUBSCRIPTION_STATUSES]),
    ]);
    // Never an entitlement computed from half the data: a failed families read
    // read as "grandfathered" (unlocking an expired trial), and a failed
    // subscriptions read as "unpaid" (locking a paying family). Either way the
    // documented answer to a read we could not make is the fail-open fallback.
    if (familyError || subscriptionsError) {
      console.error('[entitlement] family entitlement read failed', { familyError, subscriptionsError, familyId: activeId });
      return { ...UNLOCKED_FALLBACK, familyId: activeId };
    }

    const now = new Date();
    const paidLevel = (subs ?? []).filter((s) => subscriptionGrantsPaidLevel(s, now))
      .reduce((max, s) => Math.max(max, planLevel(s.plan)), 0);
    const ent = computeEntitlement({
      paidLevel,
      trialEndsAt: fam?.trial_ends_at ?? null,
      closedAt: fam?.closed_at ?? null,
      isSuperAdmin: opts.isSuperAdmin,
      now,
    });
    return { ...ent, familyId: activeId };
  } catch {
    return { ...UNLOCKED_FALLBACK, familyId: null };
  }
}
