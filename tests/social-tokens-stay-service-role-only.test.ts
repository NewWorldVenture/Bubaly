import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Audit C3-S5-01.
 *
 * `0034_social_command_center.sql` creates `social_account_tokens` with no
 * policy and says, at the point of creation, "never add a permissive policy
 * here". `0297_sensitive_tables_respect_role.sql` added four anyway, on the
 * stated premise that "every policy was is_family_member" — there were none.
 * `0303_social_tokens_service_role_only.sql` drops them again.
 *
 * A comment is what failed the first time. This is the mechanical version of
 * it: any later migration that creates a policy on the token store fails here,
 * and so does any application code that reaches for the table outside the
 * service-role path.
 */
const MIGRATIONS = 'supabase/migrations';
const RESTORED_AT = '0303';

describe('the social OAuth token store is reachable only by the service role', () => {
  it('no migration after 0303 creates a policy on it', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      if (file.slice(0, 4) <= RESTORED_AT) continue;
      const sql = readFileSync(`${MIGRATIONS}/${file}`, 'utf8')
        .replace(/--[^\n]*/g, '')
        .toLowerCase();
      if (/create\s+policy[\s\S]{0,200}?on\s+public\.social_account_tokens/.test(sql)) {
        offenders.push(file);
      }
    }
    expect(offenders, 'this table is service-role only — see migration 0034 and 0303').toEqual([]);
  });

  it('0303 drops all four policies 0297 added', () => {
    const sql = readFileSync(`${MIGRATIONS}/0303_social_tokens_service_role_only.sql`, 'utf8');
    for (const verb of ['select', 'insert', 'update', 'delete']) {
      expect(sql).toContain(`drop policy if exists social_account_tokens_${verb} on public.social_account_tokens;`);
    }
    // RLS must stay ON: with it off, "no policy" means unrestricted, not denied.
    expect(sql).toContain('alter table public.social_account_tokens enable row level security;');
  });

  it('no application code reads or writes the table', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full);
      }
    };
    ['app', 'lib', 'components'].forEach(walk);
    const offenders = files.filter((f) => {
      // policy.ts names the table precisely to forbid it, and the generated
      // types name every table there is. Neither is access.
      if (f.endsWith('lib/ai/context/policy.ts') || f.endsWith('lib/database.types.ts')) return false;
      return /from\(['"`]social_account_tokens['"`]\)/.test(readFileSync(f, 'utf8'));
    });
    expect(offenders, 'reach this table through the service-role client only').toEqual([]);
  });
});
