import { describe, expect, it, vi, beforeEach } from 'vitest';

// A social role that could not be READ became a social role that was ABSENT.
//
// getSocialAccess resolves the caller's effective role from two reads: an
// explicit social_access_permissions row, and their household family_members
// row. The explicit row WINS, and it may RESTRICT: grantAccessAction accepts
// any of the eight social roles for any active member, so demoting a parent to
// 'analyst' (view only) is first-class configuration, not a corner case.
//
// Both reads were destructured for `data` alone. A transient failure of the
// explicit read is therefore indistinguishable from "this family configured no
// explicit roles", and the demoted parent falls through to
// defaultSocialRoleForMember('parent') === 'admin' — every permission but
// manage_access, including connect_accounts, manage_settings and approve_posts.
//
// The database does not catch it. Migration 0034 templates select/insert/
// update/delete on the social tables as plain public.is_family_member(family_id);
// only social_publish_jobs_insert consults social_has_permission. For every
// other permission this function IS the boundary, so it must not guess.
//
// The sibling page already reasons exactly this way about its own reads
// ("Fail closed: a dropped social_settings error would render the form with
// DEFAULT values") — the reasoning simply never reached the shared resolver.

type Row = Record<string, unknown>;
type Result = { data: Row | null; error: { message: string } | null };

let explicitResult: Result;
let memberResult: Result;
let user: { id: string } | null;

function builder(table: string) {
  const settle = () => Promise.resolve(table === 'social_access_permissions' ? explicitResult : memberResult);
  const chain: Record<string, unknown> = {
    then: (...a: unknown[]) => settle().then(...(a as [])),
    catch: (...a: unknown[]) => settle().catch(...(a as [])),
    finally: (...a: unknown[]) => settle().finally(...(a as [])),
  };
  for (const m of ['select', 'eq']) chain[m] = () => chain;
  chain.maybeSingle = () => chain;
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: (table: string) => builder(table),
  }),
}));

const ok = (row: Row | null): Result => ({ data: row, error: null });
const failed = (): Result => ({ data: null, error: { message: 'canceling statement due to statement timeout' } });

// Rows carry the identity columns because the resolver now checks them: a row
// for another family, another user, or an inactive membership is refused
// outright (see social-access-execution for those cases).
const DEMOTED = { family_id: 'f-1', user_id: 'u-1', social_role: 'analyst', status: 'active' };
const PARENT = { family_id: 'f-1', user_id: 'u-1', role: 'parent', is_active: true };

async function access() {
  const { getSocialAccess } = await import('@/lib/social/access');
  return getSocialAccess('f-1');
}

/** The resolver's answer to a read it could not complete: an error, not null. */
async function unavailable() {
  const { SocialAccessUnavailableError } = await import('@/lib/social/access');
  await expect(access()).rejects.toBeInstanceOf(SocialAccessUnavailableError);
}

describe('a social role that could not be read', () => {
  beforeEach(() => {
    vi.resetModules();
    user = { id: 'u-1' };
    explicitResult = ok(DEMOTED);
    memberResult = ok(PARENT);
  });

  it('honours an explicit demotion when both reads succeed', async () => {
    const a = await access();
    expect(a?.role).toBe('analyst');
    expect(a?.can('connect_accounts')).toBe(false);
    expect(a?.can('manage_settings')).toBe(false);
    expect(a?.can('view_analytics')).toBe(true);
  });

  // The positive control: the household fallback must still work, or "fail
  // closed" would just mean "never resolve a role".
  it('still falls back to the household default when there is genuinely no row', async () => {
    explicitResult = ok(null);
    const a = await access();
    expect(a?.role).toBe('admin');
    expect(a?.can('connect_accounts')).toBe(true);
  });

  // The defect. Without the fix this resolves to 'admin'. The resolver now
  // THROWS rather than returning null, so "could not check" is distinguishable
  // from "not allowed" — a stronger answer another session landed.
  it('refuses rather than promoting a demoted member when the explicit read fails', async () => {
    explicitResult = failed();
    await unavailable();
  });

  // Not an escalation on its own — the explicit row is authoritative, so this
  // case resolved to 'analyst' before the fix too. It is here because the guard
  // below ALREADY failed closed on an unreadable membership whenever there was
  // no explicit row (`!member && !explicit`); the fix only makes that
  // consistent, and the test records which of the two it is.
  it('refuses when the membership read fails, even though an explicit row was readable', async () => {
    memberResult = failed();
    await unavailable();
  });

  it('refuses when both reads fail', async () => {
    explicitResult = failed();
    memberResult = failed();
    await unavailable();
  });

  // Identity control: no session is still null, by the earlier guard.
  it('refuses an unauthenticated caller', async () => {
    user = null;
    expect(await access()).toBeNull();
  });

  // Control: a non-member with no explicit row is still null, unchanged.
  it('refuses a caller who is neither a member nor explicitly granted', async () => {
    explicitResult = ok(null);
    memberResult = ok(null);
    expect(await access()).toBeNull();
  });
});
