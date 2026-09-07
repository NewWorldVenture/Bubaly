// lib/ai/observability.ts — every AI surface leaves a record.
//
// §33: "A family writes in that 'Bubaly stopped doing my Sunday meal plan' and
// nobody can answer them." `ai_requests` already has the columns — `model`,
// `prompt_tokens`, `completion_tokens`, `latency_ms`, `error`, `feature` — and
// `recordModelCall` already fills them. What was missing is that it only does so
// when handed a `requestId`, and only the concierge planner ever opened a row.
// Of ~50 model entrypoints, five carried one. Everywhere else a failure left a
// console line on a server nobody is reading, and was gone when the request
// ended.
//
// The provider RETURNS usage but records nothing, so adopting observability by
// hand is four separate edits per route: open a row, time the call, record the
// model and usage, close the row. That is why this is a wrapper and not a
// convention — four steps done by hand in forty places is four steps done wrong
// in some of them.
//
//   const brief = await withAiRequest(scope, { feature: 'briefing.daily', text }, async (obs) => {
//     const res = await provider.complete({ ... });
//     obs.used(MODEL, res.usage);
//     return res;
//   });
//
// BOOKKEEPING NEVER FAILS THE FAMILY'S WORK. If the row cannot be opened the
// body still runs, with a null request id: a family losing their meal plan
// because an observability insert failed would be the gap making itself worse.
import 'server-only';
import type { AiRequestKind, Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { MAX_AI_REQUEST_TEXT_CHARS } from '@/lib/ai/chat-request';
import { createRequest, updateRequest } from '@/lib/ai/runs/store';
import { recordModelCall } from '@/lib/ai/usage';
import type { TokenUsage } from '@/lib/ai/usage';

export type AiRequestSpec = {
  /** Dotted surface name, e.g. `briefing.daily`, `chat.assistant`. Stored on the row. */
  feature: string;
  /**
   * What the family asked for. Keep it non-sensitive — most surfaces pass a
   * fixed label ("Analyse a note") precisely so a person's own words never land
   * here. Truncated to `MAX_AI_REQUEST_TEXT_CHARS` on the way in, so a caller
   * interpolating unbounded input cannot write an unbounded row.
   */
  text: string;
  kind?: AiRequestKind;
  conversationId?: string | null;
};

export type AiObserver = {
  /** The request id, or null when the row could not be opened. */
  requestId: string | null;
  /**
   * Which model answered, and what it cost. Call once per model call — a surface
   * that makes several accumulates, because the counters are per REQUEST.
   */
  used: (model: string, usage?: TokenUsage | null) => void;
  /**
   * Report a failure the surface HANDLED itself, rather than threw.
   *
   * A streaming answer catches its own errors and falls back, so nothing ever
   * reaches this wrapper's catch — and without this the row would read
   * `completed` for a turn the family watched break. When some output was
   * already produced the row settles as `partially_completed`, which is the
   * honest description of a stream that broke halfway.
   */
  failed: (err: unknown, opts?: { partial?: boolean }) => void;
};

/** Trim an error for a column a family may end up reading in a support reply. */
function describe(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  return raw.slice(0, 500);
}

export async function withAiRequest<T>(
  scope: ServiceScope,
  spec: AiRequestSpec,
  body: (obs: AiObserver) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let requestId: string | null = null;

  const opened = await createRequest(scope, {
    kind: spec.kind ?? 'feature',
    // Bounded HERE rather than at each caller, because "keep it short" is this
    // module's own documented contract and fifteen call sites remembering a
    // rule is the same rule forgotten somewhere. The concierge intake already
    // caps this exact column at MAX_AI_REQUEST_TEXT_CHARS; a surface reaching
    // it through the wrapper was the only way in without that cap — and the
    // chat assistant's own limit is 8000, twice this one, so it was already
    // through it.
    requestText: spec.text.slice(0, MAX_AI_REQUEST_TEXT_CHARS),
    conversationId: spec.conversationId ?? null,
    feature: spec.feature,
  }).catch((err: unknown) => {
    console.error('[ai-observability] could not open a request row', { feature: spec.feature, err });
    return null;
  });
  if (opened?.ok) {
    requestId = opened.data.id;
    // `executing` with a start stamp, so a row that never completes is visibly
    // stuck rather than indistinguishable from one that was never picked up.
    // Guarded like every other write here. Without the catch, a transient
    // failure marking the row `executing` would reject out of this function and
    // take the family's brief or chat turn down with it — the one thing this
    // module promises never to do. A test pins it.
    await updateRequest(scope, requestId, { status: 'executing', started_at: new Date(started).toISOString() })
      .catch((err: unknown) => console.error('[ai-observability] request start failed', err));
  }

  const calls: Array<{ model: string; usage?: TokenUsage | null }> = [];
  // A holder rather than a bare `let`: the only writer is the closure below, and
  // control-flow narrowing cannot see through it — it narrows the variable to
  // `null` at the read and the fields stop type-checking.
  const failure: { current: { err: unknown; partial: boolean } | null } = { current: null };
  const obs: AiObserver = {
    requestId,
    used: (model, usage) => { calls.push({ model, usage }); },
    // First failure wins: a surface that falls back and then fails again is
    // still explained by what broke first.
    failed: (err, opts) => { failure.current ??= { err, partial: opts?.partial ?? false }; },
  };

  const settle = async (patch: Database['public']['Tables']['ai_requests']['Update'], ok: boolean) => {
    const latencyMs = Date.now() - started;
    // One recordModelCall per reported model call, so per-request token counters
    // accumulate the way they do on the concierge path. The latency is charged
    // once, to the first, rather than multiplied across them.
    for (const [i, call] of calls.entries()) {
      await recordModelCall({
        db: scope.db, familyId: scope.familyId, requestId,
        model: call.model, task: spec.feature, usage: call.usage,
        latencyMs: i === 0 ? latencyMs : 0, ok,
      }).catch((err: unknown) => console.error('[ai-observability] usage record failed', err));
    }
    if (requestId) {
      // When no model call was reported — a surface that failed before the
      // provider answered, or bailed out early — nothing above recorded the
      // latency, and "it failed" without "how long it took" is half a diagnosis.
      // Set it here instead. Never both: `recordModelCall` ACCUMULATES latency,
      // so writing it again would double-count every ordinary request.
      const timing = calls.length === 0 ? { latency_ms: Date.now() - started } : {};
      await updateRequest(scope, requestId, { ...patch, ...timing, completed_at: new Date().toISOString() })
        .catch((err: unknown) => console.error('[ai-observability] request close failed', err));
    }
  };

  try {
    const result = await body(obs);
    const handled = failure.current;
    if (handled) {
      await settle(
        { status: handled.partial ? 'partially_completed' : 'failed', error: describe(handled.err) },
        false,
      );
    } else {
      await settle({ status: 'completed' }, true);
    }
    return result;
  } catch (err) {
    // The row records the failure, then the error continues to the caller
    // unchanged: this observes, it does not handle.
    await settle({ status: 'failed', error: describe(err) }, false);
    throw err;
  }
}
