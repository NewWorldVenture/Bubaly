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
import { displayRunState, displayStatus, type RunState } from './states';

/** The states a run has STOPPED in: finished, partly, or not at all. */
export const RUN_OUTCOME_STATES = ['completed', 'partially_completed', 'failed', 'blocked', 'paused', 'cancelled'] as const satisfies readonly RunState[];
export type RunOutcomeState = (typeof RUN_OUTCOME_STATES)[number];

/**
 * Legacy statuses that END a run left at `state = 'awaiting_approval'`. The
 * older concierge writer closed a run with `status = 'executed'` and never
 * moved its state (lib/metric/completed-plans.ts), and the automation pages'
 * Skip wrote only `status = 'skipped'` on a run parked at an approval that had
 * closed. Its state still says "waiting"; its status says how it ended, and it
 * is read by that (LEGACY_RUN_STATUS_TO_STATE). 'pending' is the one status
 * that agrees with the state, and it stays off these lists.
 */
const ENDED_AT_APPROVAL = ['executed', 'skipped', 'dismissed'] as const;

/**
 * The PostgREST `.or()` filter for those rows: executor rows by their `state`,
 * rows the pre-0250 paths wrote — which carry the default `state = 'queued'`
 * and a meaningful legacy `status` — by the statuses `displayStatus` maps onto
 * the same states, and runs stopped at an approval by ENDED_AT_APPROVAL.
 */
export const RUN_OUTCOME_FILTER =
  `state.in.(${RUN_OUTCOME_STATES.join(',')}),and(state.eq.queued,status.in.(executed,failed,skipped,dismissed)),and(state.eq.awaiting_approval,status.in.(${ENDED_AT_APPROVAL.join(',')}))`;

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
  const endedAtApproval = row.state === 'awaiting_approval' && (ENDED_AT_APPROVAL as readonly string[]).includes(row.status ?? '');
  const state = endedAtApproval ? displayStatus(row.status) : displayRunState(row);
  return (RUN_OUTCOME_STATES as readonly string[]).includes(state)
    ? { state: state as RunOutcomeState, labelKey: LABEL_KEYS[state as RunOutcomeState] }
    : null;
}
