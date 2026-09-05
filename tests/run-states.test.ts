// The run state machine and the dependency-graph arithmetic the executor is
// built on. These are the rules that decide whether a family is told the truth
// about what Bubaly did, so they are tested directly rather than inferred from
// an integration run: a graph that reports "completed" for a plan where two
// steps failed, or a scheduler that starts a step before its dependency
// finished, is a correctness bug the UI cannot compensate for.
import { describe, expect, it } from 'vitest';
import {
  RUN_STATES, STEP_STATES, RUN_TRANSITIONS, STEP_TRANSITIONS,
  blockedSteps, canTransitionRun, canTransitionStep, describeProgress, displayRunState, displayStatus,
  findDependencyCycle, isTerminalRunState, legacyStatusFor, selectRunnableSteps, summarizeSteps,
  terminalRunStateFor, type GraphStep, type RunState, type StepState,
} from '@/lib/ai/runs/states';

function step(id: string, status: StepState, deps: string[] = [], sequence = 0): GraphStep {
  return { id, status, dependency_ids: deps, sequence };
}

describe('the state tables', () => {
  it('covers every state the 0250 CHECK constraints allow', () => {
    for (const state of RUN_STATES) expect(RUN_TRANSITIONS[state], state).toBeDefined();
    for (const state of STEP_STATES) expect(STEP_TRANSITIONS[state], state).toBeDefined();
    // Nothing may transition into a state the tables do not know about.
    for (const [from, targets] of Object.entries(RUN_TRANSITIONS)) {
      for (const to of targets) expect(RUN_STATES, `${from} -> ${to}`).toContain(to);
    }
    for (const [from, targets] of Object.entries(STEP_TRANSITIONS)) {
      for (const to of targets) expect(STEP_STATES, `${from} -> ${to}`).toContain(to);
    }
  });

  it('lets the executor park, resume and finish, and refuses to reopen a finished run', () => {
    expect(canTransitionRun('ready', 'executing')).toBe(true);
    expect(canTransitionRun('executing', 'ready')).toBe(true);            // the budget park
    expect(canTransitionRun('executing', 'awaiting_approval')).toBe(true);
    expect(canTransitionRun('awaiting_approval', 'executing')).toBe(true); // resumed by a decision
    expect(canTransitionRun('paused', 'ready')).toBe(true);
    expect(canTransitionRun('executing', 'partially_completed')).toBe(true);

    // A completed or cancelled run is a one-way door: re-opening it would let
    // finished work silently execute a second time.
    expect(canTransitionRun('completed', 'executing')).toBe(false);
    expect(canTransitionRun('cancelled', 'ready')).toBe(false);
    // A failed or partly-done run may be re-queued, because rerunStep is real.
    expect(canTransitionRun('failed', 'ready')).toBe(true);
    expect(canTransitionRun('partially_completed', 'ready')).toBe(true);
    // Same-state writes are always allowed: persisting progress is not a transition.
    expect(canTransitionRun('executing', 'executing')).toBe(true);
  });

  it('lets a step retry and be re-run, but never un-completes one', () => {
    expect(canTransitionStep('executing', 'ready')).toBe(true);   // bounded retry requeue
    expect(canTransitionStep('executing', 'awaiting_approval')).toBe(true);
    expect(canTransitionStep('failed', 'queued')).toBe(true);     // rerunStep
    expect(canTransitionStep('cancelled', 'queued')).toBe(true);
    expect(canTransitionStep('completed', 'queued')).toBe(false);
    expect(canTransitionStep('skipped', 'executing')).toBe(false);
  });

  it('knows which run states are terminal', () => {
    expect(['completed', 'partially_completed', 'failed', 'cancelled'].every((s) => isTerminalRunState(s as RunState))).toBe(true);
    // Both of these are waiting on a person, not finished.
    expect(isTerminalRunState('awaiting_approval')).toBe(false);
    expect(isTerminalRunState('blocked')).toBe(false);
    expect(isTerminalRunState('paused')).toBe(false);
  });
});

describe('the legacy 0022 status vocabulary', () => {
  it('reads the rows the concierge and automation pages already wrote', () => {
    expect(displayStatus('pending')).toBe('awaiting_approval');
    expect(displayStatus('approved')).toBe('ready');
    expect(displayStatus('executed')).toBe('completed');
    expect(displayStatus('skipped')).toBe('cancelled');
    expect(displayStatus('dismissed')).toBe('cancelled');
    expect(displayStatus('failed')).toBe('failed');
    expect(displayStatus('something-new')).toBe('queued');
    expect(displayStatus(null)).toBe('queued');
  });

  it('prefers the executor-owned state and falls back to the legacy column', () => {
    // A pre-0250 row: state is the column default, status carries the meaning.
    expect(displayRunState({ state: 'queued', status: 'executed' })).toBe('completed');
    // An executor-owned row: state wins even though status still says pending.
    expect(displayRunState({ state: 'awaiting_approval', status: 'pending' })).toBe('awaiting_approval');
    expect(displayRunState({ state: 'partially_completed', status: 'executed' })).toBe('partially_completed');
  });

  it('writes a legacy status the old surfaces can render', () => {
    expect(legacyStatusFor('completed')).toBe('executed');
    expect(legacyStatusFor('partially_completed')).toBe('executed');
    expect(legacyStatusFor('failed')).toBe('failed');
    expect(legacyStatusFor('cancelled')).toBe('skipped');
    // Only a real approval gate shows an Approve button.
    expect(legacyStatusFor('awaiting_approval')).toBe('pending');
    expect(legacyStatusFor('executing')).toBe('approved');
    expect(legacyStatusFor('ready')).toBe('approved');
  });
});

describe('step readiness', () => {
  it('runs a step only once every dependency is completed or skipped', () => {
    const steps = [
      step('a', 'completed'),
      step('b', 'skipped'),
      step('c', 'queued', ['a', 'b']),
      step('d', 'queued', ['c']),
    ];
    expect(selectRunnableSteps(steps).map((s) => s.id)).toEqual(['c']);
  });

  it('runs the independent arms of a diamond together and joins on both', () => {
    //       b
    //     /   \
    //   a       d
    //     \   /
    //       c
    const fanOut = [
      step('a', 'completed', [], 0),
      step('b', 'queued', ['a'], 1),
      step('c', 'queued', ['a'], 2),
      step('d', 'queued', ['b', 'c'], 3),
    ];
    expect(selectRunnableSteps(fanOut).map((s) => s.id)).toEqual(['b', 'c']);

    const halfJoined = [
      step('a', 'completed', [], 0),
      step('b', 'completed', ['a'], 1),
      step('c', 'executing', ['a'], 2),
      step('d', 'queued', ['b', 'c'], 3),
    ];
    expect(selectRunnableSteps(halfJoined)).toEqual([]);

    const joined = halfJoined.map((s) => (s.id === 'c' ? step('c', 'completed', ['a'], 2) : s));
    expect(selectRunnableSteps(joined).map((s) => s.id)).toEqual(['d']);
  });

  it('returns runnable steps in plan order so the concurrency slice is deterministic', () => {
    const steps = [step('z', 'queued', [], 9), step('m', 'ready', [], 3), step('a', 'queued', [], 5)];
    expect(selectRunnableSteps(steps).map((s) => s.id)).toEqual(['m', 'a', 'z']);
  });

  it('never starts a step whose dependency id does not exist', () => {
    // A planner that emits a dangling id must not cause the step to run with
    // its precondition missing.
    const steps = [step('a', 'queued', ['ghost'])];
    expect(selectRunnableSteps(steps)).toEqual([]);
    expect(blockedSteps(steps).map((s) => s.id)).toEqual(['a']);
  });

  it('blocks the whole tail behind a failure, transitively', () => {
    const steps = [
      step('a', 'failed'),
      step('b', 'queued', ['a']),
      step('c', 'queued', ['b']),
      step('d', 'queued', []),
    ];
    expect(blockedSteps(steps).map((s) => s.id).sort()).toEqual(['b', 'c']);
    expect(selectRunnableSteps(steps).map((s) => s.id)).toEqual(['d']);
  });

  it('does not re-block work that already finished', () => {
    const steps = [step('a', 'failed'), step('b', 'completed', ['a']), step('c', 'skipped', ['a'])];
    expect(blockedSteps(steps)).toEqual([]);
  });
});

describe('the cycle guard', () => {
  it('finds a two-step loop and a longer one', () => {
    expect(findDependencyCycle([step('a', 'queued', ['b']), step('b', 'queued', ['a'])])).not.toBeNull();
    const long = [step('a', 'queued', ['c']), step('b', 'queued', ['a']), step('c', 'queued', ['b'])];
    const cycle = findDependencyCycle(long);
    expect(cycle).not.toBeNull();
    expect(new Set(cycle ?? []).size).toBeGreaterThanOrEqual(3);
  });

  it('accepts a diamond, which is not a cycle', () => {
    const diamond = [
      step('a', 'queued'),
      step('b', 'queued', ['a']),
      step('c', 'queued', ['a']),
      step('d', 'queued', ['b', 'c']),
    ];
    expect(findDependencyCycle(diamond)).toBeNull();
  });

  it('accepts a graph whose dependency is missing (that is a readiness problem, not a loop)', () => {
    expect(findDependencyCycle([step('a', 'queued', ['ghost'])])).toBeNull();
  });
});

describe('how a run ends', () => {
  it('says completed only when nothing failed, was cancelled or was blocked', () => {
    const clean = summarizeSteps([step('a', 'completed'), step('b', 'skipped')]);
    expect(terminalRunStateFor(clean)).toBe('completed');

    const partial = summarizeSteps([step('a', 'completed'), step('b', 'failed')]);
    expect(terminalRunStateFor(partial)).toBe('partially_completed');

    const blocked = summarizeSteps([step('a', 'completed'), step('b', 'blocked')]);
    expect(terminalRunStateFor(blocked)).toBe('partially_completed');

    const nothing = summarizeSteps([step('a', 'failed'), step('b', 'blocked')]);
    expect(terminalRunStateFor(nothing)).toBe('failed');
  });

  it('reports "6 of 8" honestly', () => {
    const counts = summarizeSteps([
      ...Array.from({ length: 6 }, (_, i) => step(`ok${i}`, 'completed')),
      step('x', 'failed'),
      step('y', 'blocked'),
    ]);
    expect(counts).toMatchObject({ total: 8, completed: 6, failed: 1, blocked: 1 });
    expect(describeProgress(counts)).toBe('6 of 8 steps completed — 1 failed, 1 blocked.');
    expect(describeProgress(summarizeSteps([step('a', 'completed')]))).toBe('1 of 1 step completed.');
  });

  it('counts a step waiting on a person separately from work still to do', () => {
    const counts = summarizeSteps([step('a', 'awaiting_approval'), step('b', 'queued'), step('c', 'executing')]);
    expect(counts.awaitingApproval).toBe(1);
    expect(counts.pending).toBe(2);
  });
});
