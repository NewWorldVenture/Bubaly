import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The chore → complete → approve → points → reward loop is the product's
// headline flow, and its four actions were typed `Promise<void>` with SEVEN,
// five, five and three bare `return;` exits between them — `revalidatePath` on
// the success path only. So every failure did nothing observable: no toast, no
// error, not even a re-render. The parent clicked Approve, the spinner stopped,
// the card sat exactly where it was, and they clicked again, re-running the
// same failing path.
//
// The worst of them was `finalizeApproval` throwing: the assignment had already
// flipped to approved, the rollback ran, and the queue silently kept the item —
// a reward that is owed, recorded nowhere, with no error anywhere a human would
// look.
//
// The shape was never in doubt: `submitProofAction`, in this SAME FILE, already
// returned `{ ok, error }` with eight distinct messages, and the kid's submit
// form renders them. The CHILD was told why their submission failed; the PARENT
// was told nothing when the approval did.
//
// Asserted against the source because that is where the property lives — a
// return TYPE and the absence of a silent exit. Mocking four Supabase call
// chains would prove the mock.

const ACTIONS = 'app/(app)/missions/actions.ts';
const source = readFileSync(ACTIONS, 'utf8');

/** The body of a top-level exported function, from its signature to the next one. */
function bodyOf(name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, `${name} was not found in ${ACTIONS}`).toBeGreaterThan(-1);
  const next = source.indexOf('\nexport async function ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

/** Comments are prose, not control flow — a `return;` described in a header is not one. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const DECIDERS = [
  'approveSubmissionAction',
  'rejectSubmissionAction',
  'disputeSubmissionAction',
  'createChoreAction',
];

describe('a failed approval is not a silent one', () => {
  for (const name of DECIDERS) {
    it(`${name} can report a failure at all`, () => {
      // The property, not one spelling of it: main's MissionActionResult
      // (`{ ok: true } | { ok: false; error: string }`) says the same thing
      // and makes the error REQUIRED on failure, which is stronger.
      expect(bodyOf(name)).toMatch(/Promise<(\{ ok: boolean; error\?: string \}|MissionActionResult)>/);
    });

    it(`${name} has no bare return`, () => {
      // A bare `return;` in one of these is, by construction, an exit the caller
      // cannot see. Each one used to be a distinct failure mode.
      const body = withoutComments(bodyOf(name));
      const bare = [...body.matchAll(/(^|[^\w.])return\s*;/g)].length;
      expect(bare, `${name} still exits without saying why`).toBe(0);
    });

    it(`${name} answers ok on the path that succeeds`, () => {
      // Guards the guard: a function that only ever returned failures would
      // pass both assertions above.
      expect(bodyOf(name)).toContain('return { ok: true };');
    });
  }

  it('gives each failure its own message rather than one catch-all', () => {
    // Seven silent exits replaced by one "something went wrong" would be a
    // smaller defect, not a fixed one. Count the DISTINCT messages.
    const messages = new Set(
      DECIDERS.flatMap((name) => [...bodyOf(name).matchAll(/error:\s*t\('([^']+)'\)/g)].map((m) => m[1])),
    );
    expect(messages.size).toBeGreaterThanOrEqual(8);
  });

  it('renders the failure where the parent clicked', () => {
    const card = readFileSync('app/(app)/missions/review-card.tsx', 'utf8');
    // Both forms go through one helper since main's C1-S9-73; what matters is
    // that each action's result reaches setError, however it is spelled.
    for (const action of ['approveSubmissionAction', 'rejectSubmissionAction']) {
      expect(card, `${action} is not routed through the result-reading helper`).toContain(`review(${action}, fd)`);
    }
    expect(card).toMatch(/const res = await act\(fd\);[\s\S]{0,60}if \(!res\.ok\) setError\(res\.error\)/);
    expect(card).toContain('role="alert"');
  });

  it('renders the failure on the create-mission form', () => {
    const form = readFileSync('app/(app)/missions/new/create-chore-form.tsx', 'utf8');
    expect(form).toMatch(/const res = await createChoreAction\(fd\);[\s\S]{0,60}if \(!res\.ok\)/);
    expect(form).toContain('setError(');
    expect(form).toContain('role="alert"');
    // And the page hands the form over rather than wiring the action itself.
    const page = readFileSync('app/(app)/missions/new/page.tsx', 'utf8');
    expect(page).not.toContain('action={createChoreAction}');
  });

  it('does not mark an AI suggestion added when the chore was not created', () => {
    // plan-generator awaited a void action and added the item unconditionally,
    // so a suggestion refused for want of a manager role still read "Added".
    const generator = readFileSync('app/(app)/missions/new/plan-generator.tsx', 'utf8');
    const at = generator.indexOf('await createChoreAction(fd);');
    expect(at).toBeGreaterThan(-1);
    expect(generator.slice(at, at + 400)).toMatch(/if\s*\(!res(ult)?\.ok\)[\s\S]{0,140}return;/);
  });
});
