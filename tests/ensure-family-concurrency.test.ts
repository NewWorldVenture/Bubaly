import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('first-family provisioning concurrency contract', () => {
  it('uses the locked RPC as the primary provisioning path', () => {
    const source = readFileSync('lib/server/ensure-family.ts', 'utf8');
    expect(source).toContain("admin.rpc('ensure_family_for_user'");
    expect(source).toContain('compatibility path');
  });

  it('serializes the account check and writes inside one security-definer function', () => {
    const migration = readFileSync('supabase/migrations/0212_atomic_family_provisioning.sql', 'utf8');
    expect(migration).toContain('create or replace function public.ensure_family_for_user');
    expect(migration).toContain('pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0))');
    expect(migration).toContain('insert into public.families');
    expect(migration).toContain('insert into public.family_members');
    expect(migration).toContain('insert into public.user_preferences');
    expect(migration).toContain('security definer');
    expect(migration).toContain('grant execute on function public.ensure_family_for_user');
  });
});
