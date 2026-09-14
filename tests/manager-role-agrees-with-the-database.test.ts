import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { MANAGER_ROLES, ROLE_ORDER, isManager, isAdmin, type MemberRole } from '../lib/constants/roles';

/**
 * "Manager" is stated twice: once in TypeScript, where it gates what a screen
 * renders and what a server action will do, and once in SQL, where
 * can_manage_family gates what the database will actually return or accept.
 *
 * Nothing pinned them together. That is the defect class this audit kept
 * finding — F16, F18, F20, F21, F-003, F-006, F-E01 and F-E02 are one mistake
 * in eight places: authorization drawn on the screen rather than in the
 * database. A divergence here is that mistake at its source, and it fails in
 * both directions:
 *
 *   • Widen MANAGER_ROLES in TypeScript and the UI offers manager actions to a
 *     role every RLS policy still refuses — the user sees the button and the
 *     write silently does nothing.
 *   • Widen the SQL and the database accepts writes from a role the app never
 *     intended to let near them.
 *
 * So this reads the roles out of the migration that defines the function and
 * asserts the two lists are the same set.
 */
function rolesInSqlFunction(fn: string): string[] {
  const dir = 'supabase/migrations';
  // The LAST migration that defines the function is the one in force.
  const defining = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .filter((f) => readFileSync(`${dir}/${f}`, 'utf8').includes(`function public.${fn}(`));
  expect(defining.length, `no migration defines ${fn}`).toBeGreaterThan(0);
  const src = readFileSync(`${dir}/${defining.at(-1)}`, 'utf8');
  const body = src.slice(src.indexOf(`function public.${fn}(`));
  const match = /role\s*(?:=\s*'([a-z_]+)'|in\s*\(([^)]*)\))/i.exec(body);
  expect(match, `could not read the role test out of ${fn}`).toBeTruthy();
  const single = match![1];
  if (single) return [single];
  return match![2].split(',').map((r) => r.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

describe('the screen and the database agree on who may manage a family', () => {
  it('MANAGER_ROLES matches can_manage_family', () => {
    expect([...MANAGER_ROLES].sort()).toEqual(rolesInSqlFunction('can_manage_family').sort());
  });

  it('isAdmin matches is_family_admin', () => {
    const admins = ROLE_ORDER.filter((r) => isAdmin(r));
    expect(admins.sort()).toEqual(rolesInSqlFunction('is_family_admin').sort());
  });

  it('the array and the predicate agree with each other', () => {
    // lib/constants/roles.ts states "manager" TWICE — once as MANAGER_ROLES and
    // once as a hand-written isManager predicate. Two independent statements of
    // one rule in one file is the same duplication as the TS/SQL pair, just at
    // closer range: edit the array, miss the predicate, and every screen gated
    // on isManager keeps the old answer.
    const fromPredicate = ROLE_ORDER.filter((r) => isManager(r));
    expect(fromPredicate.sort()).toEqual([...MANAGER_ROLES].sort());
  });

  it('a manager role is strictly narrower than membership', () => {
    // can_manage_family must not be a synonym for is_family_member: that
    // equivalence is precisely what 0296 and 0297 had to undo.
    const members = rolesInSqlFunction('can_manage_family');
    expect(members).not.toContain('child');
    expect(members).not.toContain('teen');
  });

  it('isManager answers for exactly those roles and nothing else', () => {
    for (const role of MANAGER_ROLES) expect(isManager(role)).toBe(true);
    const nonManagers = ROLE_ORDER.filter((r: MemberRole) => !MANAGER_ROLES.includes(r));
    for (const role of [...nonManagers, '', 'PARENT', 'Parent ']) {
      expect(isManager(role), role).toBe(false);
    }
    expect(isManager(null)).toBe(false);
    expect(isManager(undefined)).toBe(false);
  });

  it('the reader is not vacuous — it really parses the roles out of the SQL', () => {
    expect(rolesInSqlFunction('can_manage_family')).toEqual(expect.arrayContaining(['parent', 'adult']));
    expect(rolesInSqlFunction('is_family_admin')).toEqual(['parent']);
  });
});
