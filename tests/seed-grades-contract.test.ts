import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// LB-014 partial fix: `grades` ships in 0006 but had NO seed anywhere, so the
// Grades section of /dashboard/family-school renders empty in a fresh env. This
// standalone seed fills ~528 realistic gradebook rows for the family's kids
// (each child × 8 subjects × ~22 assignments, scores 62–100 with matching
// letters). Depends on the anchor having child/teen members — hence it must run
// after seed_anchor_household.sql (the LB-014 root-cause fix). Proven idempotent
// on the PG16 harness (528/528 across two runs, 3 distinct kids).
const sql = readFileSync(resolve(process.cwd(), 'supabase/seed_grades.sql'), 'utf8');

describe('seed_grades contract', () => {
  it('seeds the grades table', () => {
    expect(sql).toContain('insert into public.grades');
  });

  it('assigns grades to child/teen members (skips cleanly if the family has none)', () => {
    expect(sql).toContain("coalesce(role::text,'') in ('child','teen')");
    expect(sql).toContain('run seed_anchor_household.sql first');
  });

  it('is idempotent via a [seed] title marker (grades is a leaf table — safe delete)', () => {
    expect(sql).toContain("delete from public.grades where family_id = v_family and title like '[seed]%'");
  });

  it('casts grade_type to its enum and derives a letter from the score', () => {
    expect(sql).toContain('::grade_type');
    expect(sql).toContain("when v_score >= 93 then 'A'");
  });

  it('resolves the family by the anchored account email and guards for absent table', () => {
    expect(sql).toContain('newworldventurellc@gmail.com');
    expect(sql).toContain("to_regclass('public.grades') is null");
  });

  it('never mutates Supabase-managed auth.users', () => {
    expect(sql).not.toMatch(/\b(?:insert\s+into|update|delete\s+from)\s+auth\.users\b/i);
  });
});
