import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const seed = readFileSync(
  resolve(process.cwd(), 'supabase/seed_production_readiness.sql'),
  'utf8',
);

describe('production-readiness seed pack', () => {
  it('contains 600 realistic generated records and is idempotent', () => {
    expect(seed).toContain('from generate_series(0, 599)');
    expect(seed).toMatch(/on conflict \(family_id, member_id, domain, title\) do update/i);
    expect(seed).toContain("[seed:production-readiness]");
    expect(seed).toMatch(/where target\.description like/);
  });

  it('does not clear tables or write Auth users', () => {
    expect(seed).not.toMatch(/\b(?:truncate|drop table)\b/i);
    expect(seed).not.toMatch(/\bdelete\s+from\b/i);
    expect(seed).not.toMatch(/\b(?:insert|update|delete)\s+into?\s+auth\.users\b/i);
  });

  it('fails closed instead of falling back to an arbitrary family', () => {
    expect(seed).toContain('requires the anchored account');
    expect(seed).not.toContain('select id into v_family from public.families order by created_at');
  });
});
