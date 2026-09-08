// lib/ai/runs/history.ts — the pure read model behind /dashboard/concierge/runs
// (M35: one chronological list of a family's runs, where before there were
// slices — per-run detail, the family-automation page, the two Home cards).
//
// PURE on purpose, the way lib/home/today.ts is: the page reads rows through
// `listRuns` and `loadRunEvidence` and hands them here, so the filter
// vocabulary, the ordering and what a row becomes are all pinned by
// tests/run-history-list.test.ts rather than inferred from a screenshot.
//
// TODO(M6 undo): reversing a run's writes from this list needs a migration —
// `ai_plan_steps.undone_at/undone_by`, `ai_tool_calls.created_refs jsonb`
// (table + ids) and an `undone` ai_run_events type — so nothing here offers
// an Undo. Until then recovery is manual, and the list says so by omission
// rather than with an inert button.
import { runPagePath } from '@/lib/ai/chat-request';
import { EMPTY_EVIDENCE, progressSummary, runReason, runSources, type CompletedEvidence, type CompletedSource } from '@/lib/home/today';
import { displayRunState, LEGACY_RUN_STATUS_TO_STATE, type RunState } from './states';

export const RUN_HISTORY_FILTERS = ['all', 'active', 'waiting', 'done', 'problems'] as const;
export type RunHistoryFilter = (typeof RUN_HISTORY_FILTERS)[number];

/**
 * Which §10 states each filter lists; `all` lists every state. Every state
 * belongs to exactly one of the other four (the test pins it), so a run can
 * never fall between the chips.
 */
export const RUN_HISTORY_FILTER_STATES: Readonly<Record<RunHistoryFilter, readonly RunState[] | null>> = {
  all: null,
  active: ['queued', 'planning', 'ready', 'executing', 'verifying', 'scheduled_followup', 'paused'],
  waiting: ['awaiting_context', 'awaiting_approval'],
  done: ['completed', 'partially_completed'],
  problems: ['blocked', 'failed', 'cancelled'],
};

export const RUN_HISTORY_PAGE_SIZE = 30;

/**
 * 0250 added `state` with the default 'queued' and no backfill, so every row
 * written before it still carries that default beside a meaningful legacy
 * `status` — which is exactly why the badge reads a row through
 * `displayRunState` rather than off the column. The chips have to filter on
 * that same derived value or a run finished in 2025 lands under "In progress"
 * wearing a green "Done" badge.
 */
const LEGACY_RUN_STATE: RunState = 'queued';

/** The legacy `status` values that read as one of a chip's states, by inverting LEGACY_RUN_STATUS_TO_STATE. */
function legacyStatusesReadingAs(states: readonly RunState[]): string[] {
  return Object.entries(LEGACY_RUN_STATUS_TO_STATE).filter(([, state]) => states.includes(state)).map(([status]) => status);
}

/**
 * Which pre-0250 `status` values each chip owns. `active` owns the rest by
 * default, because `displayStatus` reads an unrecognised status as 'queued' —
 * so it is described by what it excludes, and the four sets still partition
 * the vocabulary (the test pins that too).
 */
export const RUN_HISTORY_FILTER_LEGACY_STATUSES: Readonly<Record<RunHistoryFilter, readonly string[] | null>> = {
  all: null,
  active: legacyStatusesReadingAs(RUN_HISTORY_FILTER_STATES.active ?? []),
  waiting: legacyStatusesReadingAs(RUN_HISTORY_FILTER_STATES.waiting ?? []),
  done: legacyStatusesReadingAs(RUN_HISTORY_FILTER_STATES.done ?? []),
  problems: legacyStatusesReadingAs(RUN_HISTORY_FILTER_STATES.problems ?? []),
};

/** One `listRuns` call: a state predicate, plus the legacy-`status` predicate that goes with it. */
export type RunHistoryQuery = {
  states: readonly RunState[] | null;
  statuses?: readonly string[];
  excludeStatuses?: readonly string[];
};

/**
 * The reads behind one chip: one over the §10 vocabulary and, where the chip
 * also owns pre-0250 rows, one over the legacy vocabulary. Disjoint by
 * construction (the second is only rows still on the `state` default), so the
 * caller can concatenate the pages and order them as one list.
 */
export function runHistoryQueries(filter: RunHistoryFilter): RunHistoryQuery[] {
  const states = RUN_HISTORY_FILTER_STATES[filter];
  if (!states) return [{ states: null }];

  const queries: RunHistoryQuery[] = [];
  const modern = states.filter((s) => s !== LEGACY_RUN_STATE);
  if (modern.length) queries.push({ states: modern });

  if (states.includes(LEGACY_RUN_STATE)) {
    // This chip is where an unrecognised status lands, so it takes every row
    // still on the default state except the ones another chip has a word for.
    queries.push({ states: [LEGACY_RUN_STATE], excludeStatuses: legacyStatusesReadingElsewhere(states) });
  } else {
    const statuses = legacyStatusesReadingAs(states);
    if (statuses.length) queries.push({ states: [LEGACY_RUN_STATE], statuses });
  }
  return queries;
}

/** Every legacy status that reads as a state OUTSIDE this chip. */
function legacyStatusesReadingElsewhere(states: readonly RunState[]): string[] {
  return Object.entries(LEGACY_RUN_STATUS_TO_STATE).filter(([, state]) => !states.includes(state)).map(([status]) => status);
}

export function parseRunHistoryFilter(raw: unknown): RunHistoryFilter {
  return typeof raw === 'string' && (RUN_HISTORY_FILTERS as readonly string[]).includes(raw) ? (raw as RunHistoryFilter) : 'all';
}

/** A `before` cursor is an ISO instant or nothing; anything else is dropped rather than handed to the query. */
export function parseRunHistoryCursor(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The columns the history reads off a run row. Mapped by name below, so the lease, result and metadata never cross to a component. */
export type RunHistoryRunRow = {
  id: string;
  summary: string | null;
  state: string;
  status?: string | null;
  progress: unknown;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
  request_id: string | null;
  /** 0250: 'concierge' | 'routine' | 'trigger' | 'handle_it' | 'concierge_plan'. */
  run_type?: string | null;
  plan_id: string | null;
  error: string | null;
};

export type RunHistoryItem = {
  id: string;
  /** The run's summary; null when it never got one, so the page can translate the fallback. */
  title: string | null;
  state: RunState;
  href: string;
  createdAt: string;
  finishedAt: string | null;
  /** The run's own progress snapshot ("6 of 8 steps completed."), when the executor wrote one. */
  detail: string | null;
  /** The run's failure line (`family_automation_runs.error`), only when it failed or is blocked. */
  error: string | null;
  /** A run with no request row was started by a routine or a trigger, not by a person. */
  startedByRoutine: boolean;
  /** Which tools acted, from the persisted ledger; empty when nothing persisted says. */
  sources: CompletedSource[];
  /** An excerpt of the plan's persisted reasoning_summary; null when the plan recorded none. */
  reason: string | null;
};

/**
 * Newest first, by the moment the run was asked for — a history is read
 * backwards from now. Ties break on id so two renders of the same rows agree,
 * and so the pages of a chip that reads two vocabularies interleave into one
 * order before the page is cut to size.
 */
export function orderRunHistoryRows<T extends { id: string; created_at: string }>(runs: readonly T[]): T[] {
  return [...runs].sort((a, b) => {
    const t = Date.parse(b.created_at) - Date.parse(a.created_at);
    if (t !== 0 && Number.isFinite(t)) return t;
    return a.id.localeCompare(b.id);
  });
}

/** The rows a person reads, newest first — see `orderRunHistoryRows` for the order. */
export function runHistoryItems(runs: readonly RunHistoryRunRow[], evidence: CompletedEvidence = EMPTY_EVIDENCE): RunHistoryItem[] {
  return orderRunHistoryRows(runs)
    .map((r) => {
      const state = displayRunState(r);
      return {
        id: r.id,
        title: r.summary?.trim() || null,
        state,
        href: runPagePath(r.id),
        createdAt: r.created_at,
        finishedAt: r.completed_at,
        detail: progressSummary(r.progress),
        error: state === 'failed' || state === 'blocked' ? r.error : null,
        // Read provenance off the column that records it. `request_id === null`
        // says the opposite of the truth in both directions: a plan a PERSON
        // accepted is written without a request (app/(app)/dashboard/concierge/
        // actions.ts), while a cron routine creates a request first and carries
        // its id (app/api/cron/family-routines/route.ts).
        startedByRoutine: r.run_type === 'routine' || r.run_type === 'trigger',
        sources: runSources(r, evidence),
        reason: runReason(r, evidence),
      };
    });
}
