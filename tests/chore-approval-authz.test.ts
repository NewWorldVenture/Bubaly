import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-07 authorization guard. Approving a chore submission mints a wallet reward,
// and rejecting/redoing adjudicates a child's work. RLS on chore_submissions is
// family-scoped (any member, including the child who submitted), so the ONLY
// thing stopping a child from approving their own chore — and paying themselves —
// is the app-level manager gate in these server actions. This test locks that
// gate in so it cannot be dropped in a refactor.
const SRC = 'app/(app)/missions/actions.ts';

describe('A-07 chore approval requires a family manager', () => {
  const src = readFileSync(SRC, 'utf8');

  it('imports the manager role check', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bisManager\b[^}]*\}\s*from\s*'@\/lib\/constants\/roles'/);
  });

  // The gate is asserted as a GUARD CLAUSE that leaves the function, not as one
  // exact line. It used to read `if (!isManager(...)) return;` and now returns
  // `{ ok: false, error }` — because a bare `return;` was one of seven silent
  // exits that told the parent nothing when an approval failed. Matching the
  // literal would have made that fix look like the gate being dropped, which is
  // the opposite of what happened; matching the SHAPE keeps the invariant this
  // test exists for — a non-manager never reaches the body — while letting the
  // refusal say why.
  const gate = /if\s*\(!isManager\(ctx\.active\.role\)\)\s*return\b/;

  it('gates approveSubmissionAction on isManager before doing anything', () => {
    const body = src.slice(src.indexOf('export async function approveSubmissionAction'));
    const fn = body.slice(0, body.indexOf('\nexport async function', 1));
    expect(fn).toMatch(gate);
    // the gate must precede the reward-affecting call
    expect(fn.indexOf('isManager')).toBeLessThan(fn.indexOf('finalizeApproval'));
  });

  it('gates rejectSubmissionAction on isManager', () => {
    const body = src.slice(src.indexOf('export async function rejectSubmissionAction'));
    const fn = body.slice(0, body.indexOf('\nexport async function', 1));
    expect(fn).toMatch(gate);
  });

  it('the refusal tells the caller why, rather than returning silently', () => {
    // The other half of the same change: a gate that refuses in silence leaves
    // the parent clicking Approve on a card that never moves.
    for (const name of ['approveSubmissionAction', 'rejectSubmissionAction']) {
      const body = src.slice(src.indexOf(`export async function ${name}`));
      const fn = body.slice(0, body.indexOf('\nexport async function', 1));
      expect(fn, `${name} refuses without saying why`)
        .toMatch(/if\s*\(!isManager\(ctx\.active\.role\)\)\s*return\s*\{\s*ok:\s*false/);
    }
  });

  it('the manager check means parent or adult only (not child/teen)', () => {
    const roles = readFileSync('lib/constants/roles.ts', 'utf8');
    expect(roles).toMatch(/isManager\s*=\s*\([^)]*\)\s*=>\s*\n?\s*role === 'parent' \|\| role === 'adult'/);
  });
});
