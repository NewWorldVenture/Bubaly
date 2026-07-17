import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// LB-014 partial fix: school_events + sports_events ship in 0002 but had NO seed
// anywhere, so the /dashboard/family-school and /dashboard/family-sports pages
// (and the AI briefing/schedule routes that read them) render empty in a fresh
// env. This standalone seed fills 260 + 260 = 520 realistic rows for the anchor
// family. Proven idempotent on the PG16 harness (260/260 after two runs).
const sql = readFileSync(resolve(process.cwd(), 'supabase/seed_school_sports_events.sql'), 'utf8');

describe('seed_school_sports_events contract', () => {
  it('seeds both previously-unseeded tables', () => {
    expect(sql).toContain('insert into public.school_events');
    expect(sql).toContain('insert into public.sports_events');
  });

  it('is idempotent (clears its own [seed]-marked rows first)', () => {
    expect(sql).toContain("delete from public.school_events where family_id = v_family and title like '[seed]%'");
    expect(sql).toContain("delete from public.sports_events where family_id = v_family and title like '[seed]%'");
  });

  it('resolves the family by the anchored account email (not a hardcoded id)', () => {
    expect(sql).toContain('newworldventurellc@gmail.com');
    expect(sql).toContain('lower(u.email) = lower(v_email)');
  });

  it('guards for absent tables (safe before the migrations exist)', () => {
    expect(sql).toContain("to_regclass('public.school_events') is null");
    expect(sql).toContain("to_regclass('public.sports_events') is null");
  });

  it('never mutates Supabase-managed auth.users', () => {
    expect(sql).not.toMatch(/\b(?:insert\s+into|update|delete\s+from)\s+auth\.users\b/i);
  });

  it('casts the member role enum to text before comparing (no enum-cast crash)', () => {
    expect(sql).toContain("coalesce(role::text,'')");
  });
});
