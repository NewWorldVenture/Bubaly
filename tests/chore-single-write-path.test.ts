// Three of the chores board's four writes go through the service. The fourth is
// named here, with the reason, because it touches money.
//
// APPROVAL IS NOT ROUTED. There are two approval paths in this product and they
// write different rows for the same act:
//
//   `finalizeApproval` (app/(app)/missions/actions.ts) computes the reward from
//   `computeReward(rewardConfig(chore), score)`, writes BOTH `points_awarded` and
//   `cash_awarded_cents`, calls `applyCompletionRewards` — rolling the assignment
//   back if that throws — and writes an approval event via `logChoreEvent`.
//
//   The chores board writes `points_awarded: chore.points`, no cash, no
//   completion rewards, no event.
//
// So the same chore approved from two screens pays a child differently and leaves
// a different trail. Which one is right is a product decision about what the
// simple board's approval is FOR, and it moves money, so it is not a call-site
// change to make quietly. This file holds that split visible until it is decided.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MODULE = 'components/modules/chores-module.tsx';
const WRITE = /\.from\(\s*['"]chore_assignments['"]\s*\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\s*\(/g;

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
}

const writesIn = (file: string) => [...code(file).matchAll(WRITE)].map((m) => m[1]!);

describe('the chores board writes through the service', () => {
  it('reaches chores through the server action', () => {
    expect(code(MODULE)).toMatch(/from '@\/app\/\(app\)\/dashboard\/chores\/actions'/);
  });

  it('no longer sets a status, deletes an assignment, or creates a chore directly', () => {
    const src = code(MODULE);
    expect(src).not.toMatch(/\.from\('chore_assignments'\)\s*\n?\s*\.delete\(/);
    expect(src).not.toMatch(/\.from\('chores'\)\s*\n?\s*\.insert\(/);
    // The status setter and the create both went through PostgREST filtering on
    // `id` alone; the service filters `family_id` too.
    expect(src).toMatch(/setChoreStatusAction\(/);
    expect(src).toMatch(/deleteChoreAssignmentAction\(/);
    expect(src).toMatch(/createChoreAction\(/);
  });

  it('reads the SETTLED status back rather than assuming its own argument', () => {
    // `completeChoreAssignment` may land on 'done'. A toast built from the
    // requested status tells a child their finished chore is awaiting approval.
    expect(code(MODULE)).toMatch(/result\.status/);
  });

  it('keeps exactly one direct write — the approval — and it is the approval', () => {
    // Fails the day it is converted or a new direct write appears, which is the
    // point: either needs the money question answered first.
    const remaining = writesIn(MODULE);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe('update');
    expect(code(MODULE)).toMatch(/status: 'approved'/);
  });
});

describe('what the service does and does not claim', () => {
  it('keys the WHOLE chore create, not just its assignment', () => {
    // This case used to assert the opposite — that the action made no
    // idempotency claim — and it failed the day the claim became real, which is
    // what it was for. What it pins now is the shape that makes the claim true.
    //
    // `chores` is not one of 0256's six keyed tables and `chore_assignments` is.
    // Keying the ASSIGNMENT alone would be worse than nothing: a double-tapped
    // Add writes a second chore row, the probe returns the FIRST assignment, and
    // a chore nobody is assigned to is left behind. So `withIdempotency` must
    // wrap `createChore` — where the rollback can undo the losing chore — and
    // never `assignChore`, which cannot see the pair.
    const actions = code('app/(app)/dashboard/chores/actions.ts');
    expect(actions).toMatch(/submissionId/);
    expect(actions).toMatch(/makeKey\(\['tasks\.createChore'/);

    const service = code('lib/services/tasks/index.ts');
    const create = service.slice(service.indexOf('export async function createChore'));
    expect(create.slice(0, create.indexOf('\n}\n'))).toMatch(/withIdempotency/);

    const assign = service.slice(service.indexOf('export async function assignChore'));
    const assignBody = assign.slice(0, assign.indexOf('\n}\n'));
    expect(assignBody).not.toMatch(/withIdempotency/);
    // It still WRITES the key — that is what lets 0256's index refuse the
    // second insert and hand the race back to the caller that owns the pair.
    expect(assignBody).toMatch(/idempotency_key/);
  });

  it('keeps the member-status vocabulary the 0223 trigger calls member-allowed', () => {
    // 0223 guards transitions into 'approved'/'rejected'. `setChoreProgress` must
    // never grow them: the guard is defence in depth, not a substitute for the
    // service refusing to offer the door.
    const service = code('lib/services/tasks/index.ts');
    const fn = service.slice(service.indexOf('export async function setChoreProgress'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/'todo' \| 'in_progress'/);
    expect(body).not.toMatch(/'approved'/);
    expect(body).not.toMatch(/'rejected'/);
  });
});
