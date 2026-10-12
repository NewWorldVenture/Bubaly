import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runActionKey, stepIdempotencyKey } from '@/lib/ai/runs/executor';
import { scopeKey } from '@/lib/services/idempotency';
import type { ServiceScope } from '@/lib/services/types';

const ROOT = join(__dirname, '..');
const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const RUN = '00000000-0000-4000-8000-00000000ru01';
const STEP_A = '00000000-0000-4000-8000-0000000000a1';
const STEP_B = '00000000-0000-4000-8000-0000000000b2';

/**
 * THE DUPLICATE A PLAN ACTUALLY PRODUCES — NOW CLOSED BY KEYING ON WHAT IS DONE.
 *
 * What follows is the finding as it was filed (Q41, AI26). The executor now
 * supplies `runActionKey(family, run, tool, arguments)` instead of the step
 * key, so two steps that create the identical thing share one ledger key and
 * the second replays the first; a retried step still lands on its own key; and
 * the whole argument object is keyed — never a tool's natural key, which
 * leaves out the assignee and would merge "a reminder for Emma" with "a
 * reminder for Jack". The tests below pin that.
 *
 * As filed:
 *
 * `lib/ai/tools/execute.ts:resolveIdempotencyKey` names this failure mode in its
 * own words, and builds a defence for it:
 *
 *   // Deliberately keyed by the run/request and NOT the step: the duplicate a
 *   // plan actually produces is two steps creating the same thing.
 *   if (natural) return makeKey([familyId, runId ?? requestId, tool.name, natural]);
 *
 * That branch is unreachable during plan execution. `resolveIdempotencyKey`
 * short-circuits on a supplied key — `if (supplied) return supplied;` — and the
 * executor's only call site (executor.ts:920) always supplies
 * `stepIdempotencyKey(family, run, step, tool)`, a sha256 that is never empty.
 * So a plan step never consults its tool's `idempotencyFrom`, and the key it
 * gets carries the STEP.
 *
 * Step-scoping is correct for what it was chosen for — `scopeKey`'s docstring
 * says executor calls are keyed by run + step "so a retried step is
 * deduplicated", and that is true and desirable. The gap is that it is the ONLY
 * key such a call ever gets: retry-dedupe is delivered, same-thing-dedupe is
 * not, and the code written to deliver it is bypassed.
 *
 * Nothing upstream closes it either. `savePlan` (store.ts:269-283) rejects a
 * duplicate step KEY, a missing tool, an unknown dependency and a dependency
 * cycle. It never compares two steps' tool and input, so a plan carrying two
 * differently-keyed steps that create the identical thing persists intact.
 * And the service layer's `withIdempotency` reaches for `scopeKey`, which
 * carries `scope.stepId` too — so 0256's table-level unique index sees two
 * different keys as well and both rows are written.
 *
 * Impact is duplicate household rows: two identical calendar events, two todos,
 * two reminders. Not dangerous, and gated on the planner actually emitting such
 * a plan — but the repo's own comment asserts that is what plans do produce,
 * and this audit has already recorded the same class landing for real
 * ("planning a meal twice left two dinners in one slot", §7).
 */

const scopeFor = (stepId: string): ServiceScope => ({
  familyId: FAMILY, runId: RUN, stepId, requestId: null,
} as unknown as ServiceScope);

describe('two steps that do the same thing', () => {
  it('get ONE ledger key, so the second replays the first instead of writing again', () => {
    // Same family, same run, same tool, same arguments — different step.
    const input = { title: 'Dentist', starts_at: '2026-09-22T15:00:00Z', assignee_id: 'member-maya' };
    const a = runActionKey(FAMILY, RUN, 'calendar.createEvent', input);
    const b = runActionKey(FAMILY, RUN, 'calendar.createEvent', { starts_at: '2026-09-22T15:00:00Z', assignee_id: 'member-maya', title: 'Dentist ' });
    // Key order and blank padding do not make it a different request.
    expect(a).toBe(b);
    // The ledger's unique index is (family_id, idempotency_key): one key, one
    // reservation, one write; the other step gets the stored result.
    expect(new Set([a, b]).size).toBe(1);
    // The step key alone could not see that — it is still per step.
    expect(stepIdempotencyKey(FAMILY, RUN, STEP_A, 'calendar.createEvent'))
      .not.toBe(stepIdempotencyKey(FAMILY, RUN, STEP_B, 'calendar.createEvent'));
  });

  it('keeps per-person work apart: a different assignee, time or run is a different key', () => {
    const base = { title: 'Pack the soccer kit', assignee_id: 'member-emma' };
    const key = runActionKey(FAMILY, RUN, 'reminders.create', base);
    expect(runActionKey(FAMILY, RUN, 'reminders.create', { ...base, assignee_id: 'member-jack' })).not.toBe(key);
    expect(runActionKey(FAMILY, RUN, 'reminders.create', { ...base, remind_at: '2026-09-22T07:00:00Z' })).not.toBe(key);
    expect(runActionKey(FAMILY, '00000000-0000-4000-8000-00000000ru02', 'reminders.create', base)).not.toBe(key);
    expect(runActionKey(FAMILY, RUN, 'tasks.createTodo', base)).not.toBe(key);
  });

  it('the service layer keys on what the executor supplies, so it agrees', () => {
    const input = { title: 'Dentist', start: '2026-09-22T15:00:00Z' };
    // Left to itself, scopeKey still carries the step…
    const a = scopeKey(scopeFor(STEP_A), 'calendar.createEvent', input);
    const b = scopeKey(scopeFor(STEP_B), 'calendar.createEvent', input);
    expect(a, 'identical input in one run, with no key supplied, yields two keys').not.toBe(b);
    // …but `executeTool` hands the services the executor's key, and with it
    // both steps' service-level probe (0256's index) is the same row.
    const supplied = runActionKey(FAMILY, RUN, 'calendar.createEvent', input);
    const keyed = (stepId: string) => ({ ...scopeFor(stepId), idempotencyKey: supplied } as ServiceScope);
    expect(scopeKey(keyed(STEP_A), 'calendar.createEvent', input)).toBe(scopeKey(keyed(STEP_B), 'calendar.createEvent', input));
  });

  it('a retried step IS deduplicated — the mechanism works, for its own purpose', () => {
    // Non-vacuity: the same step re-executed with the same bound input gets the
    // same key every way it is computed.
    const input = { title: 'Dentist', start: '2026-09-22T15:00:00Z' };
    expect(runActionKey(FAMILY, RUN, 'calendar.createEvent', input))
      .toBe(runActionKey(FAMILY, RUN, 'calendar.createEvent', { ...input }));
    expect(stepIdempotencyKey(FAMILY, RUN, STEP_A, 'calendar.createEvent'))
      .toBe(stepIdempotencyKey(FAMILY, RUN, STEP_A, 'calendar.createEvent'));
    expect(scopeKey(scopeFor(STEP_A), 'calendar.createEvent', input))
      .toBe(scopeKey(scopeFor(STEP_A), 'calendar.createEvent', input));
  });

  it('the executor supplies the content key; the natural-key branch stays unreachable from it', () => {
    const exec = readFileSync(join(ROOT, 'lib/ai/tools/execute.ts'), 'utf8');
    const executor = readFileSync(join(ROOT, 'lib/ai/runs/executor.ts'), 'utf8');

    // The short-circuit, and the comment that says what the branch below is for.
    expect(exec).toMatch(/if \(supplied\) return supplied;/);
    // Matched as two single-line fragments: the sentence wraps in the source,
    // and pinning wrapped prose as one string is a test of formatting.
    expect(exec).toContain('Deliberately keyed by the run/request and NOT the step');
    expect(exec).toContain('two steps creating the same thing');

    // The executor's supply sites — a tool step and a notify step — both key on
    // the arguments, and none on the step alone.
    expect(
      executor.match(/idempotencyKey: runActionKey\(/g)?.length,
      'a supply site appeared or disappeared — re-check reachability',
    ).toBe(2);
    expect(executor, 'a step-only key is supplied again').not.toMatch(/idempotencyKey: stepIdempotencyKey\(/);
    // sha256 hex is never falsy, so `supplied` is always taken — which is why
    // the content has to be in the supplied key itself.
    expect(executor).toMatch(/digest\('hex'\)/);
  });

  it('savePlan validates keys, deps and cycles — never content', () => {
    const store = readFileSync(join(ROOT, 'lib/ai/runs/store.ts'), 'utf8');
    const savePlan = store.slice(store.indexOf('  if (!plan.steps.length)'), store.indexOf('const cycle = findDependencyCycle'));
    expect(savePlan).toContain('Duplicate plan step key');
    expect(savePlan).toContain('depends on unknown step');
    // The absence that matters: nothing compares two steps' tool + input.
    expect(savePlan, 'savePlan gained content comparison — re-check this finding').not.toMatch(/toolName === |sameInput|stableValue|JSON\.stringify\(step/);
  });
});
