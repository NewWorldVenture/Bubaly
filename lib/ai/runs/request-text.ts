// lib/ai/runs/request-text.ts — a request's own words.
//
// `ai_requests.request_text` is what a member typed to the concierge (or a
// routine's prompt) and `ai_requests.clarifications` holds the planner's
// questions and the member's ANSWERS. Since 0480 a member's session cannot
// select either column (#892 comment 5973332041: a child could read a sibling's
// request and answers through the Data API). The rest of the row stays
// family-readable — the F19 meter counts it through the member's session — so
// the words come through `ai_request_words`, which returns only the requests the
// caller filed, or every request of a family they manage.
//
// A request the caller may not read is simply absent from the map; the caller
// shows what it shows without the words (the plan objective, "Your request").
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';

type DB = SupabaseClient<Database>;

/**
 * Every `ai_requests` column a member's session may select (0480): all of them
 * but `request_text` and `clarifications`. A `select('*')` through a member
 * session is refused by Postgres now, so a member-facing read names these.
 */
export const MEMBER_REQUEST_COLUMNS = [
  'id', 'family_id', 'kind', 'requested_by', 'requested_by_member_id', 'conversation_id', 'source_rule_id',
  'interpreted_intent', 'intent_confidence', 'status', 'priority', 'context_stats', 'error',
  'feature', 'model', 'prompt_tokens', 'completion_tokens', 'latency_ms', 'client_request_id',
  'started_at', 'completed_at', 'created_at', 'updated_at',
].join(', ');

export type RequestWords = { requestText: string; clarifications: Json };
export type RequestWordsRead = { ok: true; words: Map<string, RequestWords> } | { ok: false; error: unknown };

/** The words of `ids` the caller may read: their own requests, or any in a family they manage. */
export async function readRequestWords(db: DB, ids: readonly string[]): Promise<RequestWordsRead> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return { ok: true, words: new Map() };
  const { data, error } = await db.rpc('ai_request_words', { p_request_ids: wanted });
  if (error) return { ok: false, error };
  const words = new Map<string, RequestWords>();
  for (const row of data ?? []) {
    if (row.id) words.set(row.id, { requestText: typeof row.request_text === 'string' ? row.request_text : '', clarifications: row.clarifications ?? [] });
  }
  return { ok: true, words };
}
