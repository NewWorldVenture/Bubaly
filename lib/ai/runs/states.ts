// The pure state model the run executor is built on: the §10 lifecycle, its
// legal transitions, and the dependency-graph arithmetic that decides which
// step may run next.
//
// WHY this is a separate, dependency-free module: everything here is the part
// of the executor that must be provably correct — a run that reports
// `completed` when two of its eight actions failed is worse than a run that
// crashed, because the family stops looking. Keeping the state machine and the
// readiness rules free of Supabase, `server-only` and the clock means they are
// exercised by real unit tests (tests/run-states.test.ts) rather than by
// inference from an integration run.
//
// The vocabulary is not invented here: `AiRunLifecycleState` and `AiStepState`
// come from lib/database.types.ts, which mirrors the CHECK constraints written
// in supabase/migrations/0250_ai_runtime_core.sql. If a state is added there it
// must be added to the transition tables below or `canTransitionRun` will
// (deliberately) refuse to move a run into it.
import type { AiRunLifecycleState, AiStepState } from '@/lib/database.types';

export type RunState = AiRunLifecycleState;
export type StepState = AiStepState;

/** Every run state, in rough lifecycle order. `paused` is run-only (a person pressed pause). */
export const RUN_STATES: readonly RunState[] = [
  'queued', 'planning', 'awaiting_context', 'awaiting_approval', 'ready', 'executing', 'verifying',
  'scheduled_followup', 'paused', 'completed', 'partially_completed', 'blocked', 'failed', 'cancelled',
] as const;

/** Every step state. Steps can be `skipped` (a false `condition`) but never `paused`. */
export const STEP_STATES: readonly StepState[] = [
  'queued', 'planning', 'awaiting_context', 'awaiting_approval', 'ready', 'executing', 'verifying',
  'scheduled_followup', 'completed', 'partially_completed', 'blocked', 'failed', 'cancelled', 'skipped',
] as const;

/**
 * A run in one of these states is finished for good: the executor will not
 * claim it again, and `claim_ai_runs` does not list them. `blocked` and
 * `awaiting_approval` are deliberately NOT terminal — they are waiting on a
 * person, and a decision or an edit puts them back in flight.
 */
export const TERMINAL_RUN_STATES: readonly RunState[] = ['completed', 'partially_completed', 'failed', 'cancelled'] as const;

/** A step in one of these states will not be scheduled again without an explicit rerun. */
export const TERMINAL_STEP_STATES: readonly StepState[] = ['completed', 'skipped', 'failed', 'cancelled', 'partially_completed'] as const;

/** Dependency satisfaction: a dependent may start only once its dependency reached one of these. */
export const SATISFYING_STEP_STATES: readonly StepState[] = ['completed', 'skipped'] as const;

/** A dependency in one of these can never be satisfied, so its dependents are blocked, not queued. */
export const UNSATISFIABLE_STEP_STATES: readonly StepState[] = ['failed', 'cancelled', 'blocked'] as const;

/**
 * Legal run transitions.
 *
 * Two entries deserve explanation. `executing → ready` is the budget park: a
 * serverless invocation that runs out of wall clock puts the run back in the
 * queue rather than failing work that actually succeeded. `failed → ready` and
 * `partially_completed → ready` exist because `rerunStep` is a real product
 * affordance (§17) — a person retries the two notifications that failed and the
 * same run finishes. `completed` and `cancelled` are one-way doors: re-opening
 * them would let a finished run silently re-execute writes.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ['planning', 'awaiting_context', 'awaiting_approval', 'ready', 'executing', 'blocked', 'failed', 'cancelled'],
  planning: ['awaiting_context', 'awaiting_approval', 'ready', 'executing', 'blocked', 'failed', 'cancelled'],
  awaiting_context: ['planning', 'ready', 'blocked', 'failed', 'cancelled'],
  awaiting_approval: ['ready', 'executing', 'partially_completed', 'blocked', 'failed', 'cancelled', 'paused'],
  ready: ['executing', 'awaiting_approval', 'scheduled_followup', 'paused', 'blocked', 'failed', 'cancelled'],
  executing: [
    'ready', 'verifying', 'awaiting_approval', 'awaiting_context', 'scheduled_followup', 'paused',
    'completed', 'partially_completed', 'blocked', 'failed', 'cancelled',
  ],
  verifying: ['executing', 'completed', 'partially_completed', 'blocked', 'failed', 'cancelled'],
  scheduled_followup: ['ready', 'executing', 'paused', 'failed', 'cancelled'],
  paused: ['ready', 'cancelled'],
  blocked: ['ready', 'planning', 'partially_completed', 'failed', 'cancelled'],
  completed: [],
  partially_completed: ['ready'],
  failed: ['ready'],
  cancelled: [],
};

/**
 * Legal step transitions. `executing → ready` is the bounded retry requeue;
 * `failed → queued` and `cancelled → queued` are `rerunStep`. A completed or
 * skipped step is frozen: re-running it is the executor's own duplicate-write
 * risk, and the only sanctioned path back is `rerunStep`, which first consults
 * the `ai_tool_calls` ledger.
 */
export const STEP_TRANSITIONS: Readonly<Record<StepState, readonly StepState[]>> = {
  queued: ['planning', 'ready', 'awaiting_context', 'awaiting_approval', 'executing', 'skipped', 'blocked', 'failed', 'cancelled'],
  planning: ['ready', 'executing', 'blocked', 'failed', 'cancelled'],
  awaiting_context: ['queued', 'ready', 'blocked', 'failed', 'cancelled'],
  awaiting_approval: ['queued', 'ready', 'executing', 'completed', 'skipped', 'blocked', 'failed', 'cancelled'],
  ready: ['executing', 'awaiting_approval', 'skipped', 'blocked', 'failed', 'cancelled'],
  executing: [
    'ready', 'verifying', 'awaiting_approval', 'scheduled_followup',
    'completed', 'partially_completed', 'blocked', 'failed', 'cancelled',
  ],
  verifying: ['completed', 'partially_completed', 'blocked', 'failed', 'cancelled'],
  scheduled_followup: ['queued', 'ready', 'executing', 'failed', 'cancelled'],
  blocked: ['queued', 'ready', 'skipped', 'failed', 'cancelled'],
  completed: [],
  partially_completed: ['completed', 'failed'],
  failed: ['queued', 'ready', 'cancelled'],
  cancelled: ['queued', 'ready'],
  skipped: [],
};

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

export function isTerminalStepState(state: StepState): boolean {
  return TERMINAL_STEP_STATES.includes(state);
}

/** Same-state writes are always allowed: persisting progress must not need a transition. */
export function canTransitionRun(from: RunState, to: RunState): boolean {
  return from === to || (RUN_TRANSITIONS[from] ?? []).includes(to);
}

export function canTransitionStep(from: StepState, to: StepState): boolean {
  return from === to || (STEP_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * The §10 state for the legacy free-text `family_automation_runs.status`
 * vocabulary that 0022 shipped and the concierge/autopilot surfaces still
 * write. 0250 added the constrained `state` column beside it rather than
 * rewriting `status` under three live readers, so every surface that shows a
 * run has to translate the old rows exactly once — here.
 */
export const LEGACY_RUN_STATUS_TO_STATE: Readonly<Record<string, RunState>> = {
  pending: 'awaiting_approval',
  approved: 'ready',
  executed: 'completed',
  skipped: 'cancelled',
  dismissed: 'cancelled',
  failed: 'failed',
};

/** The §10 state for a legacy `status` value; unknown values read as `queued` (the column has no CHECK). */
export function displayStatus(legacyStatus: string | null | undefined): RunState {
  if (!legacyStatus) return 'queued';
  return LEGACY_RUN_STATUS_TO_STATE[legacyStatus] ?? 'queued';
}

/**
 * The state to show for a run row. Rows written by the pre-0250 paths carry the
 * default `state = 'queued'` and a meaningful `status`; rows the executor owns
 * carry a meaningful `state`. Preferring `state` whenever it is not the default
 * makes both readable through one function.
 */
export function displayRunState(row: { state?: string | null; status?: string | null }): RunState {
  const state = (row.state ?? 'queued') as RunState;
  if (state !== 'queued' && RUN_STATES.includes(state)) return state;
  return displayStatus(row.status);
}

/**
 * The legacy `status` value to write beside a new `state`, so the existing
 * concierge panel (`components/concierge/autopilot-panel.tsx`) and the two
 * automation pages stop showing a finished run as "pending" forever.
 *
 * The old vocabulary has no word for "executing", so everything mid-flight maps
 * to 'approved' — which in the 0022 vocabulary means "accepted, not executed
 * yet" and is exactly what those surfaces should render for a run Bubaly is
 * still working on. Only a genuine approval gate maps back to 'pending', which
 * is the value those surfaces pair with an Approve button.
 */
export function legacyStatusFor(state: RunState): string {
  switch (state) {
    case 'completed':
    case 'partially_completed':
      return 'executed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'skipped';
    case 'awaiting_approval':
      return 'pending';
    default:
      return 'approved';
  }
}

export const RUN_STATE_LABELS: Readonly<Record<RunState, string>> = {
  queued: 'Queued',
  planning: 'Planning',
  awaiting_context: 'Needs an answer',
  awaiting_approval: 'Needs your OK',
  ready: 'Ready',
  executing: 'Working',
  verifying: 'Checking the work',
  scheduled_followup: 'Scheduled',
  paused: 'Paused',
  completed: 'Done',
  partially_completed: 'Partly done',
  blocked: 'Blocked',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// ─── Dependency graph ───────────────────────────────────────────────────────

/** The minimum a step must expose for the scheduler to reason about it. */
export type GraphStep = {
  id: string;
  status: StepState;
  dependency_ids: string[];
  sequence?: number;
};

export type StepCounts = {
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  cancelled: number;
  blocked: number;
  awaitingApproval: number;
  /** Steps that are neither terminal nor waiting on a person — work still to do. */
  pending: number;
};

export function summarizeSteps(steps: readonly GraphStep[]): StepCounts {
  const counts: StepCounts = {
    total: steps.length, completed: 0, skipped: 0, failed: 0, cancelled: 0, blocked: 0, awaitingApproval: 0, pending: 0,
  };
  for (const step of steps) {
    switch (step.status) {
      case 'completed': counts.completed += 1; break;
      case 'skipped': counts.skipped += 1; break;
      case 'failed': counts.failed += 1; break;
      case 'cancelled': counts.cancelled += 1; break;
      case 'blocked': counts.blocked += 1; break;
      case 'awaiting_approval': counts.awaitingApproval += 1; break;
      default: counts.pending += 1; break;
    }
  }
  return counts;
}

/**
 * The steps that may start right now: not yet started, and every dependency
 * already `completed` or `skipped`. Sorted by `sequence` so a plan that happens
 * to be linear executes in the order the planner wrote it, and so the bounded
 * concurrency slice is deterministic (which is what makes executor tests
 * meaningful).
 *
 * A dependency id with no matching step is treated as unsatisfied rather than
 * ignored: a planner that emits a dangling id must not cause the step to run
 * with its precondition missing.
 */
export function selectRunnableSteps<T extends GraphStep>(steps: readonly T[]): T[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  return steps
    .filter((step) => {
      if (step.status !== 'queued' && step.status !== 'ready') return false;
      return step.dependency_ids.every((depId) => {
        const dep = byId.get(depId);
        return !!dep && SATISFYING_STEP_STATES.includes(dep.status);
      });
    })
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id));
}

/**
 * Steps that can never run because something they depend on failed, was
 * cancelled, is itself blocked, or does not exist. Transitive: the whole tail of
 * a broken branch is reported in one pass, so the executor marks it `blocked`
 * and finishes honestly instead of spinning while nothing is runnable.
 */
export function blockedSteps<T extends GraphStep>(steps: readonly T[]): T[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const doomed = new Set<string>(steps.filter((s) => UNSATISFIABLE_STEP_STATES.includes(s.status)).map((s) => s.id));
  const result = new Map<string, T>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (isTerminalStepState(step.status) || step.status === 'blocked' || result.has(step.id)) continue;
      const broken = step.dependency_ids.some((depId) => !byId.has(depId) || doomed.has(depId));
      if (broken) {
        result.set(step.id, step);
        doomed.add(step.id);
        changed = true;
      }
    }
  }
  return [...result.values()];
}

/**
 * The first dependency cycle in the graph, as the ids that form it, or null.
 *
 * A cycle is not a theoretical concern: the planner is an LLM, and a plan whose
 * step B depends on C while C depends on B has no runnable step at all — the
 * executor would find nothing to do, mark the run finished with zero actions,
 * and report success for work it never attempted. `savePlan` rejects a cyclic
 * plan up front and the executor checks again before it schedules, because a
 * later plan version can reintroduce one.
 */
export function findDependencyCycle(steps: readonly GraphStep[]): string[] | null {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === 'done') return null;
    if (current === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    const step = byId.get(id);
    if (!step) return null;
    state.set(id, 'visiting');
    stack.push(id);
    for (const depId of step.dependency_ids) {
      const cycle = visit(depId);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const step of steps) {
    const cycle = visit(step.id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * The state a run ends in, given how its steps came out. The rule that matters:
 * a run only reports `completed` when nothing failed, was cancelled or was left
 * blocked. Anything else with at least one success is `partially_completed`,
 * which is what lets the UI say "6 of 8 actions completed" (§29) instead of
 * flattening a half-finished workflow into either lie.
 */
export function terminalRunStateFor(counts: StepCounts): Extract<RunState, 'completed' | 'partially_completed' | 'failed'> {
  const bad = counts.failed + counts.cancelled + counts.blocked;
  if (bad === 0) return 'completed';
  const succeeded = counts.completed + counts.skipped;
  return succeeded > 0 ? 'partially_completed' : 'failed';
}

/** "6 of 8 actions completed." — the honest one-line outcome for a finished run. */
export function describeProgress(counts: StepCounts): string {
  const done = counts.completed + counts.skipped;
  const head = `${done} of ${counts.total} step${counts.total === 1 ? '' : 's'} completed`;
  const problems: string[] = [];
  if (counts.failed) problems.push(`${counts.failed} failed`);
  if (counts.blocked) problems.push(`${counts.blocked} blocked`);
  if (counts.cancelled) problems.push(`${counts.cancelled} cancelled`);
  if (counts.awaitingApproval) problems.push(`${counts.awaitingApproval} waiting for approval`);
  return problems.length ? `${head} — ${problems.join(', ')}.` : `${head}.`;
}
