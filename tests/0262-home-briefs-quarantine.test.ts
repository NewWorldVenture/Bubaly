import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// These are static DDL safety contracts, not execution against PostgreSQL.
const raw = readFileSync('supabase/migrations/0262_home_briefs_quarantine.sql', 'utf8');
const sql = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

describe('0262 saved snapshot quarantine', () => {
  it('checks the exact existing table before changing only its row security', () => {
    expect(sql).toContain("briefs_table oid := to_regclass('public.home_briefs')");
    expect(sql).toMatch(/if briefs_table is null then raise exception '[^']*'; end if;/);
    expect(sql).toContain('lock table only public.home_briefs in access exclusive mode;');
    expect(sql).toMatch(/if not exists \( select 1 from pg_catalog\.pg_class c where c\.oid = briefs_table and c\.relkind = 'r' \) then raise exception '[^']*'; end if;/);
    expect(sql).toContain('alter table only public.home_briefs enable row level security;');
    expect(sql.match(/\balter table\b/g)).toHaveLength(1);
  });

  it('denies reads and writes for all RLS-governed roles despite existing permissive policies', () => {
    expect(sql).toContain('create policy home_briefs_snapshot_quarantine on public.home_briefs as restrictive for all to public using (false) with check (false);');
    expect(sql.match(/\bcreate policy\b/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\bas permissive\b|\bdrop policy\b|\balter policy\b/);
  });

  it('resolves an existing policy by both its relation and exact name', () => {
    expect(sql).toContain("where p.polrelid = briefs_table and p.polname = 'home_briefs_snapshot_quarantine'");
    expect(sql).toContain('pg_get_expr(p.polqual, p.polrelid) as read_rule');
    expect(sql).toContain('pg_get_expr(p.polwithcheck, p.polrelid) as write_rule');
    expect(sql).toContain('if found then');
    expect(sql).toContain('else create policy home_briefs_snapshot_quarantine');
  });

  it.each([
    'existing_policy.polpermissive is distinct from false',
    "existing_policy.polcmd is distinct from '*'",
    'existing_policy.polroles is distinct from array[0::oid]',
    "existing_policy.read_rule is distinct from 'false'",
    "existing_policy.write_rule is distinct from 'false'",
  ])('rejects an incompatible existing policy when %s', (condition) => {
    const guard = sql.match(/if existing_policy\.polpermissive .*? then raise exception '[^']*'; end if;/)?.[0] ?? '';
    expect(guard).toContain(condition);
    expect(sql.indexOf(guard)).toBeLessThan(sql.indexOf('else create policy'));
  });

  it('applies atomically without swallowing precondition failures', () => {
    expect(sql).toMatch(/^do \$quarantine\$ declare .* end; \$quarantine\$;$/);
    expect(sql).not.toMatch(/\bexception when\b|\bcommit\b|\breturn\b/);
    expect(sql.indexOf('lock table only public.home_briefs')).toBeLessThan(sql.indexOf('alter table only public.home_briefs'));
  });

  it('preserves data, ownership, keys, types, other policies and privileges', () => {
    expect(sql).not.toMatch(/\b(?:insert|update|delete|truncate|drop|grant|revoke)\b/);
    expect(sql).not.toMatch(/\b(?:add column|alter column|create table|create index|create unique index|create type|create schema|security definer|bypassrls)\b/);
    expect(sql).not.toMatch(/\b(?:member_id|created_by|permission_revision|source_revision)\b/);
  });
});
