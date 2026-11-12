// Who is calling a server action, as the session would say.
//
// The call-level role tests (Register B, "valid-input permissions") drive each
// real exported action once per household role, with the signed-in context
// stubbed the way the existing action tests stub it: `requireUserContext`
// answers a `UserContext`. This file builds that context for every role in
// two households, A (the caller's) and B (another family), with fixed fake
// uuids, so a test can seed rows that belong to either and read back what an
// action wrote.
//
// It also models the one database rule the in-memory client cannot: 0464's
// `household_write_is_not_a_guests()` guard trigger, which refuses with 42501
// an INSERT, UPDATE or DELETE by a guest of the row's family on the tables it
// is attached to (0464 for notes and seven others, 0481 for pantry_items and
// screen_time_entries). A test passes the tables the live schema guards; the
// guard answers the way PostgREST does, `{ data: null, error }`, never a throw.
import { redirect } from 'next/navigation';
import type { MemberRole } from '@/lib/constants/roles';
import { syntheticChildEmail } from '@/lib/onboarding/child-login';
import { withFaults, type FaultCall } from './in-memory-supabase';

export const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
export const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';

/** Every member role, in the order the roster shows them. */
export const MEMBER_ROLES: readonly MemberRole[] = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'];

/** A member role, or `kid`: a child signed in with a kid PIN (role child, a synthetic login email). */
export type Caller = MemberRole | 'kid';
export const CALLERS: readonly Caller[] = [...MEMBER_ROLES, 'kid'];

const ROLE_DIGIT: Record<Caller, string> = { parent: '1', adult: '2', teen: '3', child: '4', caregiver: '5', guest: '6', kid: '7' };
const familyDigit = (family: string) => (family === FAMILY_A ? 'a' : 'b');

/** The `auth.users` id of a caller in a family. */
export const userIdOf = (caller: Caller, family = FAMILY_A) =>
  `${familyDigit(family)}${ROLE_DIGIT[caller]}000000-0000-4000-8000-00000000001${ROLE_DIGIT[caller]}`;

/** The `family_members` row id of a caller in a family. */
export const memberIdOf = (caller: Caller, family = FAMILY_A) =>
  `${familyDigit(family)}${ROLE_DIGIT[caller]}000000-0000-4000-8000-00000000002${ROLE_DIGIT[caller]}`;

/** The role a caller holds in the database (`kid` is a child). */
export const roleOf = (caller: Caller): MemberRole => (caller === 'kid' ? 'child' : caller);

/** The `family_members` rows for every caller of a family, all active. */
export function memberRows(family = FAMILY_A) {
  return CALLERS.map((caller) => ({
    id: memberIdOf(caller, family),
    family_id: family,
    user_id: userIdOf(caller, family),
    role: roleOf(caller),
    display_name: `${caller} ${familyDigit(family).toUpperCase()}`,
    is_active: true,
  }));
}

/** The context `requireUserContext` answers for a caller signed in to `family`. */
export function contextFor(caller: Caller, family = FAMILY_A) {
  const role = roleOf(caller);
  const member = { id: memberIdOf(caller, family), family_id: family, user_id: userIdOf(caller, family), role, is_active: true };
  const active = {
    familyId: family,
    family: { id: family, name: `Family ${familyDigit(family).toUpperCase()}`, timezone: 'America/New_York' },
    role,
    member,
  };
  return {
    user: { id: userIdOf(caller, family), email: caller === 'kid' ? syntheticChildEmail('kid-a') : `${caller}@example.com` },
    memberships: [active],
    active,
  };
}

/** What `requireUserContext` does for a signed-out request: Next's redirect, thrown. */
export function signedOut(): never {
  redirect('/login');
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete']);

/**
 * The client with 0464's guest guard on `tables`: a write to one of them while
 * `currentRole()` is guest answers 42501 and does not land. Reads, and every
 * other table, go to the in-memory database untouched.
 */
export function withGuestGuard<T extends object>(db: T, tables: readonly string[], currentRole: () => string | null): T {
  return withFaults(db, (table: string, calls: FaultCall[]) =>
    currentRole() === 'guest' && tables.includes(table) && calls.some((call) => WRITES.has(call.method))
      ? { code: '42501', message: 'A guest can see the household but not change it' }
      : null);
}
