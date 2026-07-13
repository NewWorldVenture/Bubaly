import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0178_marketplace_circles_rls_recursion.sql'),
  'utf8',
);

describe('marketplace circles RLS repair contract', () => {
  it('uses definer membership helpers instead of querying the member table from its own policies', () => {
    expect(migration).toContain('create or replace function public.is_marketplace_circle_member');
    expect(migration).toContain('security definer');
    expect(migration).toContain('create policy mkt_circle_members_select');
    expect(migration).toContain('using (public.is_marketplace_circle_member(circle_id))');
    expect(migration).not.toMatch(/create policy mkt_circle_members_select[\s\S]*?select 1[\s\S]*?marketplace_circle_members me/i);
  });

  it('keeps share writes bound to the caller family and owned listing', () => {
    expect(migration).toContain('public.is_marketplace_circle_family_member(circle_id, family_id)');
    expect(migration).toContain('l.family_id = marketplace_listing_shares.family_id');
  });
});
