import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0258 turns `home_briefs` from a snapshot into a delivery: two kinds a day,
// an honest record of what Bubaly handled, and a timestamp for when the family
// was actually told. The unique index is the whole idempotency story, so it is
// what these guards pin.
const raw = readFileSync('supabase/migrations/0258_home_briefs_kind.sql', 'utf8');
const sql = raw.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');

describe('0258 home brief delivery', () => {
  it('adds the morning/evening kind, the handled list and the delivery stamp', () => {
    expect(sql).toContain("add column if not exists kind text not null default 'daily'");
    expect(sql).toContain("add column if not exists handled jsonb not null default '[]'::jsonb");
    expect(sql).toContain('add column if not exists delivered_at timestamptz');
    expect(sql).toContain("check (kind in ('daily', 'evening'))");
  });

  it('makes one brief per family per day per kind the database’s job', () => {
    expect(sql).toMatch(/create unique index if not exists uq_home_briefs_family_date_kind\s+on public\.home_briefs \(family_id, as_of_date, kind\)/);
    // Not partial: every row has all three, so every row is covered.
    expect(sql).not.toMatch(/uq_home_briefs_family_date_kind[\s\S]*?where/);
  });

  it('is additive: existing rows become daily briefs with nothing handled', () => {
    expect(sql).not.toMatch(/\b(drop table|drop column|delete from|truncate|update public\.)\b/i);
    expect(sql).not.toMatch(/\b(create policy|drop policy|grant|revoke)\b/i);
    expect(sql.match(/add column if not exists/g)).toHaveLength(3);
  });
});
