import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// What a chore PAYS is a manager's number. The database boundary is main's
// 0307 (`chore_price_guard` on `chores`) and 0305 (`chore_assignment_decision_guard`
// on `chore_assignments`), each a trigger guarding the PRICE COLUMNS; their
// behavioural proofs are docs/audit/chore-price-check.sql and
// docs/audit/chore-award-amount-check.sql. This pins the app-layer half.
//
// ── A correction, recorded because it is the point of the file ──────────────
//
// This branch first wrote its own migration here and made chore writes
// manager-only OUTRIGHT. That was wrong twice over, and main's work is what
// said so:
//
//   1. It collided by SYMBOL, not just by number. Both migrations created
//      `public.chore_assignment_decision_guard()` and
//      `trg_chore_assignment_decision_guard`, so whichever ran last silently
//      replaced the other's trigger — invisible to the migration ledger, which
//      only tracks file names.
//   2. It narrowed past what the screen renders. main's probe asserts as a
//      POSITIVE CONTROL that a member may still add a chore and edit its text,
//      and `components/modules/chores-module.tsx:233` offers Add to every
//      member (only the empty state at :301 gates it). The price is a
//      manager's; the chore is anyone's. This is the same rule this branch
//      applied to `driving_trips` a day earlier and then failed to apply here.
//
// So the migration was withdrawn and main's narrower rule stands. What survives
// from this branch is the SHAPE of the refusal in the missions action: main's
// guard arrived as a bare `return;`, and a silent refusal is the exact defect
// this branch fixed across these four actions.

const MISSIONS = 'app/(app)/missions/actions.ts';

describe('the missions action refuses a PRICED chore from a non-manager', () => {
  const source = readFileSync(MISSIONS, 'utf8');
  const start = source.indexOf('export async function createChoreAction(');
  const insertAt = source.indexOf("from('chores').insert(", start);

  it('checks the role before it writes', () => {
    expect(start, 'createChoreAction was not found in the missions actions').toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(start);
    // Scoped to the function body up to its first write, so the assertion
    // cannot pass on an `isManager` belonging to some other action in this file
    // — there are several, which is how the original gap was overlooked.
    const preamble = source.slice(start, insertAt);
    expect(preamble).toContain('isManager(ctx.active.role)');
  });

  it('names every payout column it is guarding', () => {
    const preamble = source.slice(start, insertAt);
    for (const column of ['points', 'points_min', 'points_max', 'cash_cents', 'cash_min_cents', 'cash_max_cents']) {
      expect(preamble, `the pricing guard does not mention ${column}`).toContain(`'${column}'`);
    }
  });

  it('refuses with something the form can render, not a bare return', () => {
    const preamble = source.slice(start, insertAt);
    const refusal = preamble.slice(preamble.indexOf('priced'));
    expect(refusal, 'a silent return tells the parent nothing').toContain('ok: false');
    expect(refusal).toContain('error:');
  });

  it('does NOT refuse an unpriced chore — the control main got right', () => {
    const preamble = source.slice(start, insertAt);
    // An `isManager` check that is not conditioned on `priced` is the blanket
    // rule this branch withdrew.
    expect(preamble).toMatch(/priced\s*&&\s*!isManager/);
  });

  it('the dashboard action is manager-only, and by its own helper', () => {
    const source = readFileSync('app/(app)/dashboard/chores/actions.ts', 'utf8');
    expect(source).toContain('refuseUnlessManager');
  });

  it('the database half is main’s, and is present', () => {
    // A guard on the app layer alone is what this whole finding is about, so the
    // test asserts the database half exists rather than standing in for it.
    const prices = readFileSync('supabase/migrations/0307_chore_prices_are_manager_set.sql', 'utf8');
    expect(prices).toContain('chore_price_guard');
    const awards = readFileSync('supabase/migrations/0305_chore_award_amounts_are_manager_set.sql', 'utf8');
    expect(awards).toContain('chore_assignment_decision_guard');
  });
});
