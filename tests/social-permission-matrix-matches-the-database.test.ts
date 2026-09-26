import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, SOCIAL_PERMISSIONS, type SocialRole } from '@/lib/social/roles';

/**
 * The social role matrix exists twice: lib/social/roles.ts, which the app
 * enforces, and public.social_has_permission, which RLS enforces and whose own
 * comment says it is "mirrored from lib/social/roles.ts". They disagreed on one
 * cell — SQL granted `admin` manage_access, JS did not — and manage_access is
 * what the social_access_permissions policies check, so a social admin could
 * rewrite anyone's role (and make themselves owner) directly against the API.
 * 0322 fixed the cell. This keeps the two copies equal, cell by cell, by
 * reading the latest migration that defines the function.
 */

function latestDefinition(): { file: string; body: string } {
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
  let found: { file: string; body: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(`supabase/migrations/${file}`, 'utf8');
    const at = sql.search(/create or replace function public\.social_has_permission\(/i);
    if (at >= 0) found = { file, body: sql.slice(at, sql.indexOf('$$;', at)) };
  }
  if (!found) throw new Error('social_has_permission is not defined in any migration');
  return found;
}

/** Evaluate the SQL CASE for one role and permission, for the three shapes it uses. */
function sqlGrants(body: string, role: string, permission: string): boolean {
  const branch = new RegExp(`when '${role}' then ([\\s\\S]*?)(?=\\n\\s*when '|\\n\\s*else )`).exec(body);
  if (!branch) throw new Error(`no SQL branch for role ${role}`);
  const expr = branch[1].trim();
  if (expr === 'true') return true;
  const not = /^p_permission <> '([a-z_]+)'$/.exec(expr);
  if (not) return permission !== not[1];
  const list = /^p_permission in\s*\(([\s\S]*)\)$/.exec(expr);
  if (list) return [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).includes(permission);
  throw new Error(`unrecognised SQL branch for ${role}: ${expr}`);
}

describe('the database and the app agree on every social permission', () => {
  const { file, body } = latestDefinition();

  it('reads the latest definition (0322 or later)', () => {
    expect(Number(file.slice(0, 4))).toBeGreaterThanOrEqual(322);
  });

  for (const role of Object.keys(ROLE_PERMISSIONS) as SocialRole[]) {
    it(`${role}: every permission matches`, () => {
      const mismatches = SOCIAL_PERMISSIONS.filter((p) => sqlGrants(body, role, p) !== ROLE_PERMISSIONS[role].includes(p));
      expect(mismatches, `${role} differs between lib/social/roles.ts and ${file}`).toEqual([]);
    });
  }

  it('still requires active membership before any role', () => {
    expect(body).toMatch(/select public\.is_family_member\(p_family_id\) and \(/);
  });
});
