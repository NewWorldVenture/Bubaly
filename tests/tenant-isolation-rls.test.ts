import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('family membership tenant boundary', () => {
  it('repairs the historical self-update policy drift', () => {
    const migration = readFileSync('supabase/migrations/0211_family_members_update_rls.sql', 'utf8');

    expect(migration).toContain('alter table public.family_members enable row level security');
    expect(migration).toContain('drop policy if exists fm_update on public.family_members');
    expect(migration).toContain('using (public.can_manage_family(family_id))');
    expect(migration).toContain('with check (public.can_manage_family(family_id))');
    expect(migration).not.toContain('or user_id = auth.uid()');
  });

  it('does not grant ordinary authenticated callers a direct membership update path', () => {
    const source = readFileSync('app/(app)/actions.ts', 'utf8');
    const profileSource = readFileSync('lib/server/profiles.ts', 'utf8');
    const childLoginSource = readFileSync('app/(app)/family/child-login-actions.ts', 'utf8');

    expect(source).not.toMatch(/from\(['"]family_members['"]\)[\s\S]*?\.update\(/);
    expect(profileSource).toContain('createServiceClient');
    expect(childLoginSource).toContain('createServiceClient');
  });
});
