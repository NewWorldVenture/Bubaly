import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';

// The held 0528 (OPSD-O05). A budget-drift signal carries the household's spend
// and limit, and 01420 lets any member read and write every family_signals row.
// The app keeps it a parent's or adult's (readsHouseholdMoney): every reader
// drops budget_drift for anyone else, and a non-manager's Refresh detects and
// deletes none. 0528 says the same in the database.

const M = 'supabase/reserved/0528_a_budget_drift_signal_is_a_parents_or_adults.sql';
const P = 'docs/audit/reserved/a-budget-drift-signal-is-a-parents-or-adults-check.sql';
const W = '.github/workflows/budget-drift-signal-runtime.yml';
const read = (p: string) => readFileSync(p, 'utf8');

describe('a budget-drift signal is a parent\'s or adult\'s (0528)', () => {
  const sql = read(M);
  const guard = bodyOf(sql, 'create or replace function public.a_budget_drift_signal_is_written_by_a_parent_or_adult()', '$$;');

  it('the app\'s rule is the managers\' rule the database uses', () => {
    expect(read('lib/finance/household-money.ts')).toContain('return isManager(role);');
    // Every reader drops budget_drift for a non-manager, so a narrowed read
    // takes nothing a non-manager's screen shows.
    expect(read('app/(app)/dashboard/family-signals/page.tsx')).toContain("rows.filter((r) => r.kind !== 'budget_drift')");
    expect(read('lib/reasoning/engine-server.ts')).toContain("inputs.signals.filter((s) => s.kind !== 'budget_drift')");
    // And a non-manager's detection writes no drift and deletes nothing.
    const detect = read('lib/intelligence/hard-signals-server.ts');
    expect(detect).toContain(".filter((s) => household || s.kind !== 'budget_drift')");
    expect(detect).toContain('const stale = !household ? [] :');
  });

  it('a restrictive read and a guard on every write, old row and new', () => {
    expect(sql).toContain("as restrictive for select to authenticated\n  using (kind <> 'budget_drift' or public.can_manage_family(family_id));");
    expect(guard).toContain("(tg_op <> 'DELETE' and new.kind = 'budget_drift' and not public.can_manage_family(new.family_id))");
    expect(guard).toContain("or (tg_op <> 'INSERT' and old.kind = 'budget_drift' and not public.can_manage_family(old.family_id))");
    expect(guard).toContain('security definer\nset search_path = public, pg_temp');
    expect(sql).toContain('before insert or update or delete on public.family_signals');
  });

  it('exempts the service role, the household\'s deletion and a member\'s removal emptying member_id', () => {
    expect(guard).toContain('if auth.uid() is null then');
    // Postgres runs the cascades from families in an order it does not fix, so
    // the parent deleting the household may no longer be its parent by then.
    expect(guard).toContain("if tg_op = 'DELETE' and not exists (select 1 from public.families f where f.id = old.family_id) then");
    expect(guard).toContain("and not exists (select 1 from public.family_members m where m.id = old.member_id)");
    expect(guard).toContain("and (to_jsonb(new) - 'member_id' - 'updated_at') = (to_jsonb(old) - 'member_id' - 'updated_at') then");
  });
});

describe('the probe and its workflow', () => {
  it('the probe measures each role\'s reads and writes and carries its controls', () => {
    const probe = read(P);
    for (const role of ["('teen', ", "('child', ", "('caregiver', "]) expect(probe, role).toContain(role);
    expect(probe).toContain("delete from public.family_members where id = '00000000-0000-4000-8528-0000000000d4';");
    expect(probe).toContain("delete from public.families where id = '00000000-0000-4000-8528-0000000000f1';");
    expect(probe).toContain("deleting the household in a session that is not its parent''s failed");
    expect(probe).toContain('-- N1. The read rule dropped and the guard disabled.');
    expect(probe).toContain('-- M1. The guard off DELETE.');
  });

  it('the workflow shows the failure, applies 0528 twice, and re-runs the released probes', () => {
    const wf = read(W);
    expect(at(wf, "- name: The released schema lets a child read and rewrite the household's budget drift")).toBeLessThan(at(wf, `-f ${M}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qE 'CONTROL|PRECONDITION'");
    expect(wf).toContain("grep -qF 'a-budget-drift-signal-is-a-parents-or-adults: OK'");
    for (const probe of ['gated-write-tables', 'family-delete-cascade', 'rls-sweep', 'plpgsql-bodies-resolve']) {
      expect(wf, probe).toContain(`docs/audit/${probe}-check.sql`);
    }
  });
});
