// Two households for request-level route tests: household A with one signed-in
// member of every role, household B with a parent of its own. Seeded into the
// in-memory database so the REAL getUserContext / requireUserContext resolves
// the caller from `family_members` — the route under test sees the same
// context a cookie session would give it. No RLS is modelled: a test that
// proves isolation proves the route's own filter, not the policy behind it.
import type { InMemorySupabase } from './in-memory-supabase';
import type { MemberRole } from '@/lib/constants/roles';

export const HOUSEHOLD_A = '00000000-0000-4000-8000-00000000000a';
export const HOUSEHOLD_B = '00000000-0000-4000-8000-00000000000b';

export const EVERY_ROLE: readonly MemberRole[] = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'];

const index = (role: MemberRole) => EVERY_ROLE.indexOf(role);

/** The signed-in user who is household A's member with this role. */
export const userA = (role: MemberRole) => `00000000-0000-4000-8000-0000000a010${index(role)}`;
/** Household A's member row for this role. */
export const memberA = (role: MemberRole) => `00000000-0000-4000-8000-0000000a020${index(role)}`;
/** Household B's parent. */
export const USER_B = '00000000-0000-4000-8000-0000000b0100';
export const MEMBER_B = '00000000-0000-4000-8000-0000000b0200';

export type HouseholdPlan = 'free' | 'basic' | 'plus' | 'trial_expired' | 'closed';

function familyRow(id: string, name: string, plan: HouseholdPlan) {
  return {
    id, name, timezone: 'America/Los_Angeles',
    // A trial that ended a month before any clock these tests set.
    trial_ends_at: plan === 'trial_expired' ? '2020-01-01T00:00:00.000Z' : null,
    closed_at: plan === 'closed' ? '2020-01-01T00:00:00.000Z' : null,
  };
}

/**
 * Seeds both households. `plan` sets household A's entitlement; household B is
 * always on Family+, so a route that read B's plan in place of A's would let a
 * refused A through.
 */
export function seedTwoHouseholds(db: InMemorySupabase, plan: HouseholdPlan = 'plus'): void {
  db.seed('families', [familyRow(HOUSEHOLD_A, 'Household A', plan), familyRow(HOUSEHOLD_B, 'Household B', 'plus')]);
  db.seed('family_members', [
    ...EVERY_ROLE.map((role) => ({
      id: memberA(role), family_id: HOUSEHOLD_A, user_id: userA(role), role, is_active: true, display_name: `A ${role}`,
    })),
    { id: MEMBER_B, family_id: HOUSEHOLD_B, user_id: USER_B, role: 'parent', is_active: true, display_name: 'B parent' },
  ]);
  const periodEnd = '2099-01-01T00:00:00.000Z';
  const subscriptions = [{ family_id: HOUSEHOLD_B, plan: 'plus', status: 'active', current_period_end: periodEnd }];
  if (plan === 'basic' || plan === 'plus') subscriptions.push({ family_id: HOUSEHOLD_A, plan, status: 'active', current_period_end: periodEnd });
  db.seed('subscriptions', subscriptions);
}
