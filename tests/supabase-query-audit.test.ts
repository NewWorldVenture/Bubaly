import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { auditSupabaseQueries, readSchema } from '../scripts/audit-supabase-queries.mjs';

type Finding = { kind: string; detail: string; file: string; line: number; via?: string };

describe('supabase query audit', () => {
  it('finds nothing wrong in the current tree', () => {
    const { findings } = auditSupabaseQueries() as { findings: Finding[] };
    const describeFinding = (f: Finding) => `${f.kind} ${f.detail} at ${f.file}:${f.line}`;
    expect(findings.map(describeFinding)).toEqual([]);
  });

  it('still sees a real schema, not an empty one', () => {
    // A parser regression that silently produced zero tables would make the
    // audit above pass vacuously, which is the only way this gate can rot.
    const { columns, functions } = auditSupabaseQueries().schema;
    expect(columns.size).toBeGreaterThan(400);
    expect(functions.size).toBeGreaterThan(50);
    expect(columns.get('meal_plans')).toContain('plan_date');
    expect(columns.get('meal_plans')).not.toContain('planned_for');
    expect(columns.get('chores')).not.toContain('assignee_id');
  });

  describe('schema parsing', () => {
    const parse = (sql: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'bubaly-schema-'));
      writeFileSync(join(dir, '0001_test.sql'), sql);
      return readSchema(dir);
    };

    it('reads columns from create table and later add column', () => {
      const { columns } = parse(`
        create table if not exists public.widgets (
          id uuid primary key default gen_random_uuid(),
          family_id uuid not null references public.families(id),
          label text not null,
          unique (family_id, label)
        );
        alter table public.widgets add column if not exists retired_at timestamptz;
      `);
      expect([...columns.get('widgets')].sort()).toEqual(['family_id', 'id', 'label', 'retired_at']);
    });

    it('does not mistake a table constraint for a column', () => {
      const { columns } = parse(`
        create table public.gadgets (
          id uuid primary key,
          name text,
          constraint gadgets_name_key unique (name),
          check (name <> '')
        );
      `);
      expect(columns.get('gadgets')).not.toContain('constraint');
      expect(columns.get('gadgets')).not.toContain('check');
    });

    it('recognises a quoted policy name', () => {
      // `CREATE POLICY "Authenticated read invest_assets" ON …` is a real shape
      // in this repo. Missing it reports a policied table as deny-all.
      const { withPolicy } = parse(`
        create table public.catalog (id uuid primary key, is_active boolean);
        alter table public.catalog enable row level security;
        create policy "Authenticated read catalog" on public.catalog
          for select to authenticated using (is_active = true);
      `);
      expect(withPolicy.has('catalog')).toBe(true);
    });
  });
});
