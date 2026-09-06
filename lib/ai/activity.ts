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

/** The columns the console shows. Selected by name so a new column never leaks by default. */
const COLUMNS =
  'id, family_id, feature, kind, status, model, prompt_tokens, completion_tokens, ' +
  'latency_ms, error, request_text, requested_by, requested_by_member_id, ' +
  'conversation_id, created_at, started_at, completed_at';

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

/** `%` and `_` are wildcards in ILIKE; a family searching for "50%" means the characters. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
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
  const q = (filters.q ?? '').trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
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
