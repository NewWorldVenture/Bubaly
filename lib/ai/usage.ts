// lib/ai/usage.ts — token/latency accounting for every model call.
//
// WHY: §33 (observability) and §34 (cost management) both need to answer "what
// did this family's AI actually cost this month", and the audited map decided
// `ai_requests` doubles as the per-household usage meter rather than adding a
// second ledger (map §2, ai_requests row). So a model call records itself in two
// places and nowhere else:
//
//   • `ai_requests` — prompt/completion tokens and latency are ACCUMULATED onto
//     the request, because one request can make several model calls (classify →
//     plan → summarize) and the allowance report reads one row per request.
//   • `ai_run_events` — a metrics-only `model_call` event so the run timeline
//     shows where the time and tokens went. The payload is deliberately limited
//     to {task, model, prompt_tokens, completion_tokens, latency_ms, ok,
//     error_code}: `ai_run_events` is readable by every family member, so prompt
//     or context text must never reach it (0250's header states this).
//
// Recording is best-effort and never throws. A model call that succeeded must
// not be turned into a user-visible failure because the meter could not be
// written; every failure is logged instead, which is the same fail-open posture
// the rest of the AI telemetry uses. (Read paths that are a source of truth
// still fail closed — this is not one.)

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';

export type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

type OpenAIUsagePayload = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
};

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/**
 * Read OpenAI's `usage` object off a Chat Completions response. Returns null
 * when the field is absent (streamed responses without `stream_options`, or a
 * provider that omits it) so callers can tell "no data" from "zero tokens".
 */
export function usageFromOpenAI(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as OpenAIUsagePayload;
  if (u.prompt_tokens === undefined && u.completion_tokens === undefined && u.total_tokens === undefined) return null;
  const inputTokens = toCount(u.prompt_tokens);
  const outputTokens = toCount(u.completion_tokens);
  const declaredTotal = toCount(u.total_tokens);
  return { inputTokens, outputTokens, totalTokens: declaredTotal || inputTokens + outputTokens };
}

/** Sum two usage readings (null counts as zero) — a request spans several calls. */
export function addUsage(a: TokenUsage | null | undefined, b: TokenUsage | null | undefined): TokenUsage {
  const left = a ?? ZERO_USAGE;
  const right = b ?? ZERO_USAGE;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export type RecordModelCallArgs = {
  db: SupabaseClient<Database>;
  familyId: string;
  requestId?: string | null;
  model: string;
  task: string;
  usage?: TokenUsage | null;
  latencyMs: number;
  ok: boolean;
  errorCode?: string | null;
  /** When the call happened inside a run, the timeline gets a `model_call` event. */
  runId?: string | null;
  stepId?: string | null;
};

/**
 * Record one model call. Safe to call from any code path, including crons using
 * the service client: every write is scoped by `family_id`, and both writes are
 * independent so a failure of one still records the other.
 */
export async function recordModelCall(args: RecordModelCallArgs): Promise<void> {
  const { db, familyId, requestId, model, task, usage, latencyMs, ok, errorCode, runId, stepId } = args;
  const latency = Number.isFinite(latencyMs) && latencyMs >= 0 ? Math.round(latencyMs) : 0;

  if (requestId) {
    // Accumulate rather than overwrite: the counters are per REQUEST, and a
    // request routinely makes more than one model call.
    const { data: current, error: readError } = await db
      .from('ai_requests')
      .select('prompt_tokens, completion_tokens, latency_ms')
      .eq('id', requestId)
      .eq('family_id', familyId)
      .maybeSingle();
    if (readError) {
      console.error('[ai-usage] request usage read failed', readError);
    } else if (current) {
      const patch: Database['public']['Tables']['ai_requests']['Update'] = {
        model,
        prompt_tokens: (current.prompt_tokens ?? 0) + (usage?.inputTokens ?? 0),
        completion_tokens: (current.completion_tokens ?? 0) + (usage?.outputTokens ?? 0),
        latency_ms: (current.latency_ms ?? 0) + latency,
      };
      const { error: updateError } = await db
        .from('ai_requests')
        .update(patch)
        .eq('id', requestId)
        .eq('family_id', familyId);
      if (updateError) console.error('[ai-usage] request usage update failed', updateError);
    }
  }

  if (runId) {
    const payload: Json = {
      task,
      model,
      prompt_tokens: usage?.inputTokens ?? null,
      completion_tokens: usage?.outputTokens ?? null,
      total_tokens: usage?.totalTokens ?? null,
      latency_ms: latency,
      ok,
      error_code: errorCode ?? null,
    };
    const { error: eventError } = await db.from('ai_run_events').insert({
      family_id: familyId,
      run_id: runId,
      request_id: requestId ?? null,
      step_id: stepId ?? null,
      event_type: 'model_call',
      message: ok ? `${task} · ${model}` : `${task} · ${model} failed (${errorCode ?? 'error'})`,
      payload,
      actor_kind: 'ai',
    });
    if (eventError) console.error('[ai-usage] model_call event insert failed', eventError);
  }
}
