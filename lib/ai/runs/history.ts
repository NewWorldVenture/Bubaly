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
import { displayRunState, type RunState } from './states';

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
 * backwards from now. Ties break on id so two renders of the same rows agree.
 */
export function runHistoryItems(runs: readonly RunHistoryRunRow[], evidence: CompletedEvidence = EMPTY_EVIDENCE): RunHistoryItem[] {
  return [...runs]
    .sort((a, b) => {
      const t = Date.parse(b.created_at) - Date.parse(a.created_at);
      if (t !== 0 && Number.isFinite(t)) return t;
      return a.id.localeCompare(b.id);
    })
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
        startedByRoutine: r.request_id === null,
        sources: runSources(r, evidence),
        reason: runReason(r, evidence),
      };
    });
}
