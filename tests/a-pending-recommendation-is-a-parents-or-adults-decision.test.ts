import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';

// The held 0530 (CALHUB-O3, the database half of CALHUB-02). A pending
// recommendation waits on the parents, and 0022's one policy lets any member
// write family_ai_recommendations. The app makes every write a parent's or
// adult's, or the server's; 0530 says the same in the database.

const M = 'supabase/reserved/0530_a_pending_recommendation_is_a_parents_or_adults_decision.sql';
const P = 'docs/audit/reserved/a-pending-recommendation-is-a-parents-or-adults-decision-check.sql';
const W = '.github/workflows/recommendation-decision-runtime.yml';
const read = (p: string) => readFileSync(p, 'utf8');

describe('a pending recommendation is a parent\'s or adult\'s decision (0530)', () => {
  const sql = read(M);
  const guard = bodyOf(sql, 'create or replace function public.a_recommendation_is_decided_by_a_parent_or_adult()', '$$;');

  it('every app writer is a parent\'s or adult\'s, or the server\'s', () => {
    const actions = read('lib/family/actions.ts');
    expect(bodyOf(actions, 'export async function setRecommendationStatus(', '.from(\'family_ai_recommendations\')'))
      .toContain('if (!isManager(ctx.active.role)) {');
    expect(actions).toContain("  'family_ai_recommendations',");
    // The planner files its cards through the run ledger, which is the service
    // client for a member's request.
    expect(read('lib/ai/planner/index.ts')).toContain("const { data, error } = await ledger\n    .from('family_ai_recommendations')");
    expect(read('lib/ai/runs/store.ts')).toContain('return createServiceClient();');
  });

  it('one guard for every write, old row and new', () => {
    expect(guard).toContain('security definer\nset search_path = public, pg_temp');
    expect(guard).toContain("(tg_op <> 'DELETE' and not public.can_manage_family(new.family_id))");
    expect(guard).toContain("or (tg_op <> 'INSERT' and not public.can_manage_family(old.family_id))");
    expect(guard).toContain('if auth.uid() is null then');
    // Postgres runs the cascades from families in an order it does not fix.
    expect(guard).toContain("if tg_op = 'DELETE' and not exists (select 1 from public.families f where f.id = old.family_id) then");
    expect(guard).toContain("and (to_jsonb(new) - 'member_id' - 'updated_at') = (to_jsonb(old) - 'member_id' - 'updated_at') then");
    expect(sql).toContain('before insert or update or delete on public.family_ai_recommendations');
    expect(sql).not.toMatch(/create policy|drop policy/);
  });
});

describe('the probe and its workflow', () => {
  it('the probe measures each role and carries its controls', () => {
    const probe = read(P);
    for (const role of ["('teen', ", "('child', ", "('caregiver', ", "('guest', "]) expect(probe, role).toContain(role);
    expect(probe).toContain("delete from public.family_members where id = '00000000-0000-4000-8530-0000000000d4';");
    expect(probe).toContain("deleting the household in a session that is not its parent''s failed");
    expect(probe).toContain('-- N1. The guard disabled.');
    expect(probe).toContain('-- M1. The guard checking the new row only.');
  });

  it('the workflow shows the failure, applies 0530 twice, and re-runs the released probes', () => {
    const wf = read(W);
    expect(at(wf, "- name: The released schema lets a child decide the parents' pending recommendations")).toBeLessThan(at(wf, `-f ${M}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qE 'CONTROL|PRECONDITION'");
    expect(wf).toContain("grep -qF 'a-pending-recommendation-is-a-parents-or-adults-decision: OK'");
    expect(wf).toContain('docs/audit/gated-write-tables-check.sql');
  });
});
