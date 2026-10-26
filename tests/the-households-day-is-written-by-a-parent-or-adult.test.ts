import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';

// The held 0529 (OPSD-O06, COORD-O01). The Family Operating Index, the
// reasoning snapshot and the workload history are the household's day and week,
// written by the app only from a load that reads the household (a parent's or
// adult's) or from the service role; their policies let any member write them.
// 0529 puts a parent-or-adult guard on all three.

const M = 'supabase/reserved/0529_the_households_day_is_written_by_a_parent_or_adult.sql';
const P = 'docs/audit/reserved/the-households-day-is-written-by-a-parent-or-adult-check.sql';
const W = '.github/workflows/household-day-runtime.yml';
const read = (p: string) => readFileSync(p, 'utf8');

describe('the household\'s day is written by a parent or adult (0529)', () => {
  const sql = read(M);
  const guard = bodyOf(sql, 'create or replace function public.a_household_day_is_written_by_a_parent_or_adult()', '$$;');

  it('the app writes these rows only from a household-reach load or a manager\'s action', () => {
    expect(read('lib/operating-index/server.ts')).toContain("if (reach === 'household') {\n    try {");
    expect(read('lib/reasoning/engine-server.ts')).toContain("if (reach === 'member') return composeReport(inputs, viewer, now);");
    expect(read('app/(app)/dashboard/workload/actions.ts')).toContain('if (!isManager(ctx.active.role)) return { ok: true };');
    expect(read('lib/finance/household-money.ts')).toContain('return isManager(role);');
  });

  it('one guard for every write, old row and new, on all three tables', () => {
    expect(guard).toContain('security definer\nset search_path = public, pg_temp');
    expect(guard).toContain("(tg_op <> 'DELETE' and not public.can_manage_family(new.family_id))");
    expect(guard).toContain("or (tg_op <> 'INSERT' and not public.can_manage_family(old.family_id))");
    expect(sql).toContain("foreach t in array array['family_operating_index', 'reasoning_snapshots', 'workload_snapshots'] loop");
    expect(sql).toContain("'create trigger %I before insert or update or delete on public.%I '");
    expect(sql).not.toMatch(/create policy|drop policy/);
  });

  it('names no table-specific column, so the body resolves on all three', () => {
    // member_id is workload_snapshots' alone; it is read through to_jsonb.
    expect(guard).toContain("(to_jsonb(old) ->> 'member_id')");
    expect(guard).not.toMatch(/\b(new|old)\.member_id\b/);
    expect(guard).toContain('if auth.uid() is null then');
    // Postgres runs the cascades from families in an order it does not fix.
    expect(guard).toContain("if tg_op = 'DELETE' and not exists (select 1 from public.families f where f.id = old.family_id) then");
  });
});

describe('the probe and its workflow', () => {
  it('the probe measures each role on each table and carries its controls', () => {
    const probe = read(P);
    for (const role of ["('teen', ", "('child', ", "('caregiver', "]) expect(probe, role).toContain(role);
    for (const tbl of ["('family_operating_index',", "('reasoning_snapshots',", "('workload_snapshots',"]) expect(probe, tbl).toContain(tbl);
    expect(probe).toContain("delete from public.family_members where id = '00000000-0000-4000-8529-0000000000d4';");
    expect(probe).toContain("deleting the household in a session that is not its parent''s failed");
    expect(probe).toContain('-- N1. The guards disabled.');
    expect(probe).toContain('-- M1. The guard checking the new row only.');
  });

  it('the workflow shows the failure, applies 0529 twice, and re-runs the released probes', () => {
    const wf = read(W);
    expect(at(wf, "- name: The released schema lets a child rewrite the household's day")).toBeLessThan(at(wf, `-f ${M}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qE 'CONTROL|PRECONDITION'");
    expect(wf).toContain("grep -qF 'the-households-day-is-written-by-a-parent-or-adult: OK'");
    for (const probe of ['gated-write-tables', 'family-delete-cascade', 'plpgsql-bodies-resolve']) {
      expect(wf, probe).toContain(`docs/audit/${probe}-check.sql`);
    }
  });
});
