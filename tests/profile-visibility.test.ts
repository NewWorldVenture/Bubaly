import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// PRIV-002. `profiles_select_self` shows co-members' profiles to each other.
// Before 0336 it ignored `is_active`, and a removed member's row stays (inactive)
// and visible to the family, so the family kept reading the removed person's
// email, name, birth date and phone — including a number changed after they
// left. docs/audit/profile-visibility-ends-with-membership-check.sql proves the
// behaviour on a real catalogue; this keeps the LAST definition in the
// migration history honest, since the policy has already been re-created once
// (0118) and a copy of that text would quietly undo 0336.

const executable = (raw: string) => raw.replace(/^\s*--.*$/gm, '');

function lastDefinition(): { file: string; sql: string } {
  const files = readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql')).sort();
  let found: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = executable(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    const at = sql.search(/create policy profiles_select_self\b/i);
    if (at >= 0) found = { file, sql: sql.slice(at, sql.indexOf(';', at)) };
  }
  if (!found) throw new Error('profiles_select_self is never created');
  return found;
}

describe('a profile is visible to active co-members only (PRIV-002)', () => {
  it('is last defined by 0336 or later', () => {
    expect(lastDefinition().file >= '0336').toBe(true);
  });

  it('requires both memberships to be active', () => {
    const { sql } = lastDefinition();
    expect(sql).toMatch(/me\.user_id = auth\.uid\(\) and me\.is_active/);
    expect(sql).toMatch(/them\.user_id = public\.profiles\.id and them\.is_active/);
  });

  it('still lets everyone read their own profile', () => {
    expect(lastDefinition().sql).toMatch(/id = auth\.uid\(\)\s+or exists/);
  });
});
