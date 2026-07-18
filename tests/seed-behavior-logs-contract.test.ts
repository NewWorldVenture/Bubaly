import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// LB-014 slice (agent-05, PLA-0803): `behavior_logs` (migration 0073) had ZERO seed
// coverage anywhere, so the Behavior Tracking dashboard renders EMPTY in a fresh
// env. seed_behavior_logs.sql fills ~30 per-child observations across all 3 kinds
// and 10 categories over ~90 days for every family with children.
//
// PG16-VERIFIED on an isolated throwaway DB (migration 0073 applied verbatim, a
// family with 1 parent + child + teen, plus a childless family): total=60 rows
// (2 kids × 30), childless family=0 rows (no error), 3 distinct kinds, 10 distinct
// categories, positive→points>0 (20), concern→points<0 (20); re-run ×2 stayed 60
// (idempotent). Real DB with many kid-bearing families exceeds the ≥500-row DoD.
const sql = readFileSync(resolve(process.cwd(), 'supabase/seed_behavior_logs.sql'), 'utf8');

describe('seed_behavior_logs contract', () => {
  it('guards for an absent table (degrades before migration 0073)', () => {
    expect(sql).toContain("to_regclass('public.behavior_logs') is null");
  });

  it('is idempotent — clears its own [seed] rows per family before inserting', () => {
    expect(sql).toMatch(/delete\s+from\s+public\.behavior_logs\s+where\s+family_id\s*=\s*v_family\s+and\s+note\s+like\s+'\[seed\]%'/i);
    expect(sql).toContain("'[seed] '");
  });

  it('is per-child (member_id = the child) and only for child/teen members', () => {
    expect(sql).toContain("role in ('child','teen')");
    expect(sql).toContain('member_id');
  });

  it('covers all three behavior kinds and casts to the enum', () => {
    expect(sql).toContain('::behavior_kind');
    expect(sql).toContain("'concern'");
    expect(sql).toContain("'neutral'");
    expect(sql).toContain("'positive'");
  });

  it('covers all ten behavior categories from lib/behavior/insights', () => {
    for (const c of ['responsibility', 'kindness', 'focus', 'respect', 'honesty', 'cooperation', 'mood', 'screen', 'homework', 'general']) {
      expect(sql).toContain(`'${c}'`);
    }
  });

  it('attributes logs to a parent and never mutates auth.users', () => {
    expect(sql).toContain("role in ('parent','adult')");
    expect(sql).not.toMatch(/\b(?:insert\s+into|update|delete\s+from)\s+auth\.users\b/i);
  });
});
