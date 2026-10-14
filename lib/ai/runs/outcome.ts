// How a run that has stopped ENDED, for the two automation pages' "recent runs"
// lists (/dashboard/autonomous-family-management, /dashboard/family-automation).
//
// Both pages used to select on the legacy `status` column, and `legacyStatusFor`
// (./states.ts) writes 'approved' for every state mid-flight — executing,
// verifying, ready — and for blocked and paused, and 'executed' for
// partially_completed. So a run Bubaly was still working on, one the executor
// had blocked for its requester and one it had paused all rendered under
// "Completed Automations" with a green check, and a failed run ('failed') was
// never selected at all: the list said "No automations have run yet".
//
// The list is now chosen and labelled by the §10 state (`displayRunState`), the
// one the run pages show: only a completed run reads as done.
import { displayRunState, type RunState } from './states';

/** The states a run has STOPPED in: finished, partly, or not at all. */
export const RUN_OUTCOME_STATES = ['completed', 'partially_completed', 'failed', 'blocked', 'paused', 'cancelled'] as const satisfies readonly RunState[];
export type RunOutcomeState = (typeof RUN_OUTCOME_STATES)[number];

/**
 * The PostgREST `.or()` filter for those rows: executor rows by their `state`,
 * and rows the pre-0250 paths wrote — which carry the default `state = 'queued'`
 * and a meaningful legacy `status` — by the statuses `displayStatus` maps onto
 * the same states.
 */
export const RUN_OUTCOME_FILTER =
  `state.in.(${RUN_OUTCOME_STATES.join(',')}),and(state.eq.queued,status.in.(executed,failed,skipped,dismissed))`;

export type RunOutcome = {
  state: RunOutcomeState;
  /** Catalogue key for the word shown beside the run. */
  labelKey: string;
};

const LABEL_KEYS: Readonly<Record<RunOutcomeState, string>> = {
  completed: 'runOutcome.completed',
  partially_completed: 'runOutcome.partiallyCompleted',
  failed: 'runOutcome.failed',
  blocked: 'runOutcome.blocked',
  paused: 'runOutcome.paused',
  cancelled: 'runOutcome.cancelled',
};

/** How a stopped run ended, or null for a run that has not stopped. */
export function runOutcome(row: { state?: string | null; status?: string | null }): RunOutcome | null {
  const state = displayRunState(row);
  return (RUN_OUTCOME_STATES as readonly string[]).includes(state)
    ? { state: state as RunOutcomeState, labelKey: LABEL_KEYS[state as RunOutcomeState] }
    : null;
}
