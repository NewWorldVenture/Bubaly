// A cookie session for the REAL site-admin gate: lib/supabase/auth's getUser and
// isSuperAdmin, and lib/auth/super-admin-assurance, all read the client
// `createServer()` hands them. A test mocks `@/lib/supabase/server` so that
// `createServer` answers `cookieSession(db, state)`, and the gate then decides
// from the fixture alone:
//
//  - `auth.getUser()` answers the session's user, or Supabase's own
//    AuthSessionMissingError for a signed-out visitor;
//  - `rpc('is_super_admin')` answers what 0008's function does: is the JWT's
//    email (lowercased) in public.super_admins;
//  - `auth.getSession()` / `auth.mfa.getAuthenticatorAssuranceLevel()` answer
//    the session's assurance, or an error when it is `null` (unreadable).
//
// It also seeds two households with a member in every family role, so a test
// can prove that no family role reaches a site-admin surface.
import type { InMemorySupabase } from './in-memory-supabase';
import type { MemberRole } from '@/lib/constants/roles';

export type AssuranceLevels = { currentLevel: 'aal1' | 'aal2'; nextLevel: 'aal1' | 'aal2' };
export const STEPPED_UP: AssuranceLevels = { currentLevel: 'aal2', nextLevel: 'aal2' };
export const PASSWORD_ONLY: AssuranceLevels = { currentLevel: 'aal1', nextLevel: 'aal2' };
export const NO_FACTOR: AssuranceLevels = { currentLevel: 'aal1', nextLevel: 'aal1' };

export type SessionUser = { id: string; email: string };
export type SessionState = { user: SessionUser | null; assurance: AssuranceLevels | null };

export const HOUSEHOLD_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const HOUSEHOLD_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** A site admin granted in the database (super_admins), member of no household. */
export const SITE_ADMIN: SessionUser = { id: 'aaaaaaaa-0000-4000-8000-0000000000ff', email: 'site.admin@example.com' };

/** Household A, one account per family role; the child is a kid login. */
export const MEMBERS_A: Record<MemberRole, SessionUser> = {
  parent: { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'parent.a@example.com' },
  adult: { id: 'aaaaaaaa-0000-4000-8000-000000000002', email: 'adult.a@example.com' },
  teen: { id: 'aaaaaaaa-0000-4000-8000-000000000003', email: 'teen.a@example.com' },
  child: { id: 'aaaaaaaa-0000-4000-8000-000000000004', email: 'child.sam@kids.bubaly.app' },
  caregiver: { id: 'aaaaaaaa-0000-4000-8000-000000000005', email: 'caregiver.a@example.com' },
  guest: { id: 'aaaaaaaa-0000-4000-8000-000000000006', email: 'guest.a@example.com' },
};
export const PARENT_B: SessionUser = { id: 'bbbbbbbb-0000-4000-8000-000000000001', email: 'parent.b@example.com' };

export const FAMILY_ROLES = Object.keys(MEMBERS_A) as MemberRole[];

export function seedTwoHouseholds(db: InMemorySupabase): void {
  const at = '2026-01-01T00:00:00Z';
  db.seed('families', [
    { id: HOUSEHOLD_A, name: 'Household A', created_at: at, updated_at: at, closed_at: null },
    { id: HOUSEHOLD_B, name: 'Household B', created_at: at, updated_at: at, closed_at: null },
  ]);
  db.seed('family_members', [
    ...FAMILY_ROLES.map((role, i) => ({ id: `aaaaaaaa-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, family_id: HOUSEHOLD_A, user_id: MEMBERS_A[role].id, role, is_active: true })),
    { id: 'bbbbbbbb-0000-4000-8000-000000000100', family_id: HOUSEHOLD_B, user_id: PARENT_B.id, role: 'parent', is_active: true },
  ]);
  db.seed('profiles', [...Object.values(MEMBERS_A), PARENT_B, SITE_ADMIN].map((u) => ({ id: u.id, email: u.email })));
  db.seed('super_admins', [{ email: SITE_ADMIN.email }]);
}

const SESSION_MISSING = { name: 'AuthSessionMissingError', message: 'Auth session missing!', status: 400 };

/** The cookie-bound client `createServer()` would build for this session. */
export function cookieSession(db: InMemorySupabase, state: SessionState) {
  return {
    auth: {
      getUser: async () => (state.user
        ? { data: { user: { id: state.user.id, email: state.user.email } }, error: null }
        : { data: { user: null }, error: SESSION_MISSING }),
      getSession: async () => ({ data: { session: state.user ? { access_token: 'test-fake-access-token' } : null }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => (state.assurance
          ? { data: { ...state.assurance }, error: null }
          : { data: null, error: { name: 'AuthApiError', message: 'assurance unavailable', status: 503 } }),
      },
    },
    rpc: async (name: string) => {
      if (name !== 'is_super_admin') return { data: null, error: { code: '42883', message: `function ${name} does not exist` } };
      const email = (state.user?.email ?? '').toLowerCase();
      return { data: db.table('super_admins').some((row) => row.email === email), error: null };
    },
    from: (table: string) => db.from(table),
  };
}
