import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0317 is the real boundary — the browser talks to PostgREST with the anon key,
// so a server action is never the thing that stops a child, and
// docs/audit/chore-price-write-boundary-check.sql proves the policies and the
// trigger behaviourally. This pins the app-layer half.
//
// There are TWO `createChoreAction`s. `app/(app)/dashboard/chores/actions.ts`
// opens with `refuseUnlessManager` and is pinned by
// tests/chore-manager-only-writes.test.ts. `app/(app)/missions/actions.ts` had a
// doc comment reading "Parent creates a chore" and no check at all — and
// /missions gates on PLAN, not on role (`requireFeature`), so nothing upstream
// caught it either. A chore IS the price list: points, cash_cents,
// auto_approve_score, the min/max bounds.
//
// The check belongs in both places for the reason the sibling file already
// states: the boundary is the policy, but the screen's claim lives here, so
// this is where a refusal can be explained instead of arriving as an RLS error
// the form cannot render.

const MISSIONS = 'app/(app)/missions/actions.ts';

describe('both createChoreActions check the role they claim to', () => {
  it('the missions action refuses a non-manager before it writes', () => {
    const source = readFileSync(MISSIONS, 'utf8');
    const start = source.indexOf('export async function createChoreAction(');
    expect(start, 'createChoreAction was not found in the missions actions').toBeGreaterThan(-1);

    // Scoped to the function body up to its first write, so the assertion
    // cannot pass on an `isManager` that belongs to some other action in this
    // file — there are several, which is exactly how this one was overlooked.
    const insertAt = source.indexOf("from('chores').insert(", start);
    expect(insertAt).toBeGreaterThan(start);
    const preamble = source.slice(start, insertAt);
    expect(preamble).toContain('isManager(ctx.active.role)');
  });

  it('the dashboard action still does too, and by its own helper', () => {
    const source = readFileSync('app/(app)/dashboard/chores/actions.ts', 'utf8');
    expect(source).toContain('refuseUnlessManager');
  });

  it('the migration and its probe are present and name the payout columns', () => {
    // A guard on the app layer alone is what this whole finding is about, so
    // the test asserts the database half exists rather than standing in for it.
    const migration = readFileSync('supabase/migrations/0317_the_price_list_is_not_the_childs_to_write.sql', 'utf8');
    expect(migration).toContain('chores_mng_update');
    for (const column of ['points_awarded', 'cash_awarded_cents', 'approved_by', 'approved_at']) {
      expect(migration, `the guard does not mention ${column}`).toContain(column);
    }
    // The case 0223 could not see: a payout change with no status transition.
    expect(migration).toContain('new.points_awarded is distinct from old.points_awarded');

    const probe = readFileSync('docs/audit/chore-price-write-boundary-check.sql', 'utf8');
    expect(probe).toContain('a child set their own cash payout without moving the status');
    expect(probe).toContain('a child rewrote the payout on an already-approved assignment');
  });
});
