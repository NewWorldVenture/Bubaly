// lib/ai/activity.ts — reading the `ai_requests` ledger back.
//
// §33 has two halves. The first is that surfaces record what they did, which
// `withAiRequest` now does for fifteen of them. The second is the one the gap
// row actually names: "a family writes in that 'Bubaly stopped doing my Sunday
// meal plan' and NOBODY CAN ANSWER THEM." Rows nothing reads answer nobody, and
// until this module no application code selected from `ai_requests` at all
// except `loadRunDetail`, which needs a run — so the twelve feature surfaces,
// which have no run, were write-only.
//
// The query work lives here rather than in the page because the test runner is
// `environment: 'node'` and cannot render a server component. A page that holds
// its own filtering is a page whose filtering is never tested.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiRunState, Database } from '@/lib/database.types';
import { RUN_STATES } from '@/lib/ai/runs/states';

export const AI_ACTIVITY_PAGE_SIZE = 25;

/**
 * The columns the console shows. Selected by name so a new column never leaks
 * by default.
 *
 * Typed against the GENERATED row type rather than written as a string. A
 * hand-written select list is a runtime failure waiting for its first typo:
 * PostgREST rejects the query, the page shows its read-error state, and neither
 * a stubbed unit test nor `next build` would have noticed. `satisfies` turns
 * that into a compile error instead. (`created_at` is real but lives on the
 * `& Stamps` half of the row type, which is exactly the sort of thing worth
 * having the compiler confirm rather than eyeballing.)
 */
const COLUMN_LIST = [
  'id', 'family_id', 'feature', 'kind', 'status', 'model',
  'prompt_tokens', 'completion_tokens', 'latency_ms', 'error', 'request_text',
  'requested_by', 'requested_by_member_id', 'conversation_id',
  'created_at', 'started_at', 'completed_at',
] as const satisfies readonly (keyof Database['public']['Tables']['ai_requests']['Row'])[];

const COLUMNS = COLUMN_LIST.join(', ');

export type AiActivityRow = {
  id: string;
  family_id: string;
  feature: string | null;
  kind: string;
  status: AiRunState;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  error: string | null;
  request_text: string;
  requested_by: string | null;
  requested_by_member_id: string | null;
  conversation_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type AiActivityFilters = {
  status?: string;
  feature?: string;
  familyId?: string;
  /** Substring over `feature` and `error` — deliberately NOT over `request_text`. */
  q?: string;
  page?: number;
};

/**
 * The states that mean "this went wrong", as opposed to "this is still going".
 * `partially_completed` belongs here: the family got half an answer, which is
 * the complaint they write in about.
 */
export const AI_FAILURE_STATES: readonly AiRunState[] = ['failed', 'partially_completed', 'blocked'] as const;

/** Still moving. A row stuck in one of these for hours is its own kind of bug. */
export const AI_IN_FLIGHT_STATES: readonly AiRunState[] = [
  'queued', 'planning', 'awaiting_context', 'ready', 'executing', 'verifying',
] as const;

/**
 * The statuses an `ai_requests` row can actually hold.
 *
 * NOT `RUN_STATES`, which is `AiRunLifecycleState[]` and includes `paused` — a
 * person pressing pause on a RUN, which no request row ever carries. Validating
 * against `RUN_STATES` would let `?status=paused` through to a query that
 * always matches nothing, and the type predicate saying so would be a lie the
 * compiler catches.
 */
export const AI_REQUEST_STATES: readonly AiRunState[] =
  RUN_STATES.filter((s): s is AiRunState => s !== 'paused');

/**
 * A status from a URL is a string from a stranger. PostgREST parameterises it,
 * so an unknown value is not an injection — it is worse in a duller way: it
 * matches nothing, and the console shows an empty table that reads as "no AI
 * activity" rather than "that is not a status". Unknown values are dropped and
 * reported, so the page can say which filter it ignored.
 */
export function normalizeStatusFilter(raw: string | undefined): { status: AiRunState | null; ignored: string | null } {
  const value = (raw ?? '').trim();
  if (!value) return { status: null, ignored: null };
  const match = AI_REQUEST_STATES.find((s) => s === value);
  return match ? { status: match, ignored: null } : { status: null, ignored: value };
}

/**
 * Make a free-text term safe to embed in a PostgREST `or=(...)` filter.
 *
 * TWO different escaping problems, and only the second one is obvious.
 *
 * 1. `%` and `_` are ILIKE wildcards. A family searching for "50%" means those
 *    characters, not "50 followed by anything".
 * 2. `,` `(` `)` are STRUCTURAL inside `or=(...)`: they separate and group the
 *    conditions. Interpolating a term containing one splits the filter into
 *    pieces PostgREST then rejects or, worse, reads as different conditions.
 *    Every other `.or()` in this repo interpolates a UUID or an ISO timestamp,
 *    which cannot contain them; this is the only one taking a person's text.
 *
 * The structural characters are replaced with a space rather than quoted and
 * escaped. Quoting is the more general fix, but its correctness rests on
 * PostgREST's tokenizer behaving as documented, which nothing here can test —
 * and a search box that quietly drops a parenthesis is a far smaller failure
 * than one that returns wrong rows. Dots survive, because `wallet.coach` is a
 * feature name someone will reasonably type, and a dot inside the value half of
 * `column.operator.value` is not structural.
 */
function safeSearchTerm(value: string): string {
  return value
    .replace(/[(),]/g, ' ')
    .replace(/[\\%_]/g, (c) => `\\${c}`)
    .trim();
}

export type AiActivityPage = {
  rows: AiActivityRow[];
  /** Total matching the filters, not the page — the server counts, we do not guess. */
  total: number;
  page: number;
  pageCount: number;
  ignoredStatus: string | null;
};

/**
 * One page of the ledger, newest first.
 *
 * Filtering and counting happen in PostgreSQL, not in JavaScript over a capped
 * fetch. The difference matters here: "show me every failure" over a table that
 * grows by a row per AI call is exactly the query a capped fetch answers wrongly
 * and silently, by showing the failures inside the last N rows and calling it
 * all of them.
 */
export async function listAiActivity(
  db: SupabaseClient<Database>,
  filters: AiActivityFilters = {},
): Promise<{ ok: true; data: AiActivityPage } | { ok: false; error: string }> {
  const { status, ignored } = normalizeStatusFilter(filters.status);
  const page = Math.max(1, Math.trunc(filters.page ?? 1) || 1);
  const from = (page - 1) * AI_ACTIVITY_PAGE_SIZE;

  let query = db
    .from('ai_requests')
    .select(COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, from + AI_ACTIVITY_PAGE_SIZE - 1);

  if (status) query = query.eq('status', status);
  if (filters.feature) query = query.eq('feature', filters.feature);
  if (filters.familyId) query = query.eq('family_id', filters.familyId);
  const term = safeSearchTerm(filters.q ?? '');
  if (term) {
    const like = `%${term}%`;
    query = query.or(`feature.ilike.${like},error.ilike.${like}`);
  }

  const { data, count, error } = await query;
  if (error) {
    console.error('[ai-activity] read failed', error);
    return { ok: false, error: 'Could not read the AI request ledger.' };
  }

  const total = count ?? 0;
  return {
    ok: true,
    data: {
      rows: (data ?? []) as unknown as AiActivityRow[],
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / AI_ACTIVITY_PAGE_SIZE)),
      ignoredStatus: ignored,
    },
  };
}

export type AiActivitySummary = { failed: number; inFlight: number; total: number };

/**
 * Counts since `sinceIso`, for the strip at the top of the page.
 *
 * Three head-only counts rather than one fetch-and-tally: the point of the
 * summary is to be right about a table nobody wants to load, and `head: true`
 * asks PostgreSQL for the number without shipping a single row.
 */
export async function summarizeAiActivity(
  db: SupabaseClient<Database>,
  sinceIso: string,
): Promise<AiActivitySummary> {
  const base = () => db.from('ai_requests').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso);
  const [failed, inFlight, total] = await Promise.all([
    base().in('status', AI_FAILURE_STATES),
    base().in('status', AI_IN_FLIGHT_STATES),
    base(),
  ]);
  // A failed count is not worth an error page — the table below is the real
  // content, and a dash beats a 500.
  for (const res of [failed, inFlight, total]) {
    if (res.error) console.error('[ai-activity] summary count failed', res.error);
  }
  return { failed: failed.count ?? 0, inFlight: inFlight.count ?? 0, total: total.count ?? 0 };
}

/**
 * Feature names seen in the recent window, for the filter dropdown.
 *
 * Deliberately a window and not a DISTINCT over the whole table: PostgREST has
 * no distinct, and a full scan to populate a dropdown is a bad trade. The caller
 * keeps whatever value the URL already carries even when it is not in this list,
 * so a bookmarked filter for a feature that has been quiet still works.
 */
export async function recentAiFeatures(db: SupabaseClient<Database>, window = 500): Promise<string[]> {
  const { data, error } = await db
    .from('ai_requests')
    .select('feature')
    .not('feature', 'is', null)
    .order('created_at', { ascending: false })
    .limit(window);
  if (error) {
    console.error('[ai-activity] feature list read failed', error);
    return [];
  }
  return [...new Set((data ?? []).map((r) => r.feature).filter((f): f is string => Boolean(f)))].sort();
}

// ─── X3 · rework rate ────────────────────────────────────────────────────────
//
// "How often does Bubaly get it right the first time?" is the quality question
// the ledger can already answer and nothing asked. A run that had to be
// replanned, or whose steps had to be retried, cost the family patience even
// when it finished — so counting only `completed` flatters the product.
//
// The measure is deliberately over TERMINAL runs, not over all of them: a run
// still executing is not yet evidence either way, and including it would make
// the number drift with load rather than with quality.

/** Lifecycle states that mean the run is over, however it ended. */
export const TERMINAL_RUN_STATES: readonly string[] = [
  'completed', 'partially_completed', 'failed', 'blocked', 'cancelled',
] as const;

/**
 * Run events that mean work had to be done twice.
 *
 * `replanned` has no `AiRunEventType` today — replanning shows up as a SECOND
 * `ai_plans` version for the same request, which `plansByRequest` carries. The
 * name is matched anyway so that adding the event type later needs no change
 * here.
 */
export const REWORK_EVENT_TYPES: readonly string[] = ['step_retried', 'replanned'] as const;

export type ReworkRunRow = { id: string; request_id: string | null; state: string };
export type ReworkEventRow = { run_id: string; event_type: string };

export type ReworkSummary = {
  /** Runs that ended, in any terminal state — the denominator. */
  terminal: number;
  /** Completed, one plan version, no retries: right the first time. */
  firstTimeRight: number;
  /** Terminal runs that were not right the first time. */
  reworked: number;
  /** firstTimeRight / terminal, 0..1. `null` when no run has ended yet. */
  firstTimeRightRate: number | null;
  /** reworked / terminal, 0..1. `null` when no run has ended yet. */
  reworkRate: number | null;
};

/**
 * X3 — the rework rate over a window of runs.
 *
 * `plansByRequest` maps an `ai_requests.id` to how many `ai_plans` versions
 * exist for it; a request with two or more versions was replanned. A run with
 * no `request_id` cannot have been replanned through a request, so it is judged
 * on its events alone rather than being excluded — dropping it would quietly
 * shrink the denominator toward the runs we happen to understand best.
 */
export function summarizeRework(
  runs: ReworkRunRow[],
  plansByRequest: Record<string, number>,
  events: ReworkEventRow[],
): ReworkSummary {
  const reworkedRuns = new Set<string>();
  for (const e of events) {
    if (REWORK_EVENT_TYPES.includes(e.event_type)) reworkedRuns.add(e.run_id);
  }

  let terminal = 0;
  let firstTimeRight = 0;
  for (const run of runs) {
    if (!TERMINAL_RUN_STATES.includes(run.state)) continue;
    terminal++;
    if (run.state !== 'completed') continue;
    if (reworkedRuns.has(run.id)) continue;
    const versions = run.request_id ? (plansByRequest[run.request_id] ?? 1) : 1;
    if (versions > 1) continue;
    firstTimeRight++;
  }

  const reworked = terminal - firstTimeRight;
  return {
    terminal,
    firstTimeRight,
    reworked,
    firstTimeRightRate: terminal > 0 ? firstTimeRight / terminal : null,
    reworkRate: terminal > 0 ? reworked / terminal : null,
  };
}
