import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// LB-014 ROOT CAUSE: the anchor/demo family is created by the family trigger with
// ONLY its parent — no children — so every kid-dependent seed block (chores,
// allowances, grades, kid wallets/investing) produces 0 rows for the anchor and
// the marketplace hand-off/returns seeds ERROR ("requires two existing members").
// seed_anchor_household.sql gives the anchor a co-parent + 3 kids with
// deterministic (family-scoped) ids so re-runs are a non-destructive no-op.
// Proven on the PG16 harness: anchor parent=1 → parent/adult/teen/child×2; a
// SEED_ALL re-run then "Seeded 160 pickup hand-offs" instead of erroring.
const sql = readFileSync(resolve(process.cwd(), 'supabase/seed_anchor_household.sql'), 'utf8');

describe('seed_anchor_household contract', () => {
  it('adds child + teen members (unblocks kid-role-filtered seeds)', () => {
    expect(sql).toContain("array['teen','teen'");
    expect(sql).toContain("array['child1','child'");
    expect(sql).toContain("array['child2','child'");
  });

  it('adds a co-parent so the family has >=2 members (fixes marketplace 2-member seeds)', () => {
    expect(sql).toContain("array['coparent','adult'");
  });

  it('uses deterministic per-family ids + on-conflict-do-nothing (non-destructive, no cascade)', () => {
    expect(sql).toContain("md5(v_family::text || ':household:'");
    expect(sql).toContain('on conflict (id) do nothing');
    // Must NOT delete members (would cascade-orphan kid data attached by later seeds).
    expect(sql).not.toMatch(/delete\s+from\s+public\.family_members/i);
  });

  it('resolves the family by the anchored account email (works on harness + prod)', () => {
    expect(sql).toContain('newworldventurellc@gmail.com');
    expect(sql).toContain('lower(u.email) = lower(v_email)');
  });

  it('casts the role to the member_role enum and guards for absent table', () => {
    expect(sql).toContain('::public.member_role');
    expect(sql).toContain("to_regclass('public.family_members') is null");
  });

  it('never mutates Supabase-managed auth.users', () => {
    expect(sql).not.toMatch(/\b(?:insert\s+into|update|delete\s+from)\s+auth\.users\b/i);
  });
});
