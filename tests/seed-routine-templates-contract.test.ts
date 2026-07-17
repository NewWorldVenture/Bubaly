import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// LB-014 partial fix: routine_templates + routine_template_items ship in 0122 but
// had NO seed anywhere, so the calendar Routines panel
// (components/modules/routines-panel.tsx, which reads routine_templates) renders
// empty in a fresh env. This standalone seed fills 60 templates × 9 items = 540
// rows for the anchor family. Proven idempotent on the PG16 harness (60/540 after
// two runs; clearing templates cascades to items via the 0122 FK).
const sql = readFileSync(resolve(process.cwd(), 'supabase/seed_routine_templates.sql'), 'utf8');

describe('seed_routine_templates contract', () => {
  it('seeds both the template and its items', () => {
    expect(sql).toContain('insert into public.routine_templates');
    expect(sql).toContain('insert into public.routine_template_items');
  });

  it('is idempotent via a [seed] name marker (items cascade on delete)', () => {
    expect(sql).toContain("delete from public.routine_templates where family_id = v_family and name like '[seed]%'");
  });

  it('resolves the family by the anchored account email', () => {
    expect(sql).toContain('newworldventurellc@gmail.com');
    expect(sql).toContain('lower(u.email) = lower(v_email)');
  });

  it('guards for absent tables (safe before migration 0122)', () => {
    expect(sql).toContain("to_regclass('public.routine_templates') is null");
    expect(sql).toContain("to_regclass('public.routine_template_items') is null");
  });

  it('casts item category to the event_category enum', () => {
    expect(sql).toContain('::public.event_category');
  });

  it('never mutates Supabase-managed auth.users', () => {
    expect(sql).not.toMatch(/\b(?:insert\s+into|update|delete\s+from)\s+auth\.users\b/i);
  });
});
