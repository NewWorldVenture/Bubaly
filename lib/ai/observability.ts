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
import type { AI_ALLOWANCE_EXCEEDED } from '@/lib/ai/runs/store';
import { recordModelCall } from '@/lib/ai/usage';
import { monthlyAllowanceFor } from '@/lib/constants/ai-allowance';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { isSuperAdminCaller } from '@/lib/server/super-admin-caller';
import type { TokenUsage } from '@/lib/ai/usage';

export type AiRequestSpec = {
  /** Dotted surface name, e.g. `briefing.daily`, `chat.assistant`. Stored on the row. */
  feature: string;
  /**
   * A fixed label for what was asked ("Analyse a note", "Assistant turn") —
   * never the person's own words or anything derived from them. The row is
   * readable by every active member of the family (0250's SELECT policy), so a
   * message typed to the assistant, a pasted note or a trip destination written
   * here would be shown to the rest of the household. Every call site passes a
   * string literal; `tests/an-ai-request-row-never-carries-what-was-typed.test.ts`
   * holds them to it. Still truncated to `MAX_AI_REQUEST_TEXT_CHARS`.
   */
  text: string;
  kind?: AiRequestKind;
  conversationId?: string | null;
  /**
   * The caller's retry key for this logical request, stored on the row under
   * the (family_id, client_request_id) unique index. When a row with this key
   * already exists the body does NOT run: `AiRequestDuplicate` is thrown before
   * the model, so a retry that raced past the caller's own lookup files no
   * second row and repeats no effect.
   */
  clientRequestId?: string | null;
  /**
   * F19: on a capped plan the row is ADMITTED — counted and filed as one
   * decision (`admit_ai_request`, 0477) — and a family at its allowance is
   * refused with `AiRequestOverAllowance` before the body runs. `true` keeps
   * the row as a record only — filed with `metered = false`, so it is neither
   * counted nor refused by the allowance (0477) — for a surface the owner
   * classified as not charged, such as chore-proof validation. A system scope
   * is always treated this way. Unlimited plans are never admitted either way.
   */
  exemptFromAllowance?: boolean;
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
// The store's refusal code, held to it by type so the two cannot drift. A value
// import would make every test that mocks the store declare it.
const OVER_ALLOWANCE: typeof AI_ALLOWANCE_EXCEEDED = 'allowance_exceeded';

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

  // The plan is read ONCE, before the filing (F19): it decides both how the
  // row is filed (admitted against the allowance, or plainly) and whether a
  // failed filing refuses.
  const plan = await filingPlan(scope);
  // Work the family did not ask for is recorded but never charged (owner,
  // #771 review 5391362628): a surface classified exempt, or anything running
  // on a system scope (a cron job, inbound routing).
  const exempt = Boolean(spec.exemptFromAllowance) || scope.actorKind === 'system';

  const filing = (allowance: number | null) => createRequest(scope, {
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
    clientRequestId: spec.clientRequestId ?? null,
    allowance,
    unmetered: exempt,
  }).catch((err: unknown) => {
    console.error('[ai-observability] could not open a request row', { feature: spec.feature, err });
    return null;
  });
  let opened = await filing(exempt ? null : plan.allowance);
  // A super-administrator is never refused by the allowance — the gate's own
  // rule (`assertAIAccess`), which this admission cannot see because a scope
  // carries no email. Asked only after a refusal; the row is then filed as it
  // was before the admission existed: plainly, and counted.
  if (opened && !opened.ok && opened.code === OVER_ALLOWANCE && await isSuperAdminCaller(scope)) {
    opened = await filing(null);
  }
  // The family is at its allowance: admitted and counted in one decision under
  // a per-family lock, so N concurrent requests at 9 of 10 admit exactly one.
  // Nothing below runs and no row was filed.
  if (opened && !opened.ok && opened.code === OVER_ALLOWANCE && plan.allowance !== null) {
    throw new AiRequestOverAllowance(spec.feature, plan.allowance);
  }
  // With a retry key the row is also the idempotency record. A filing that
  // failed — including a key collision whose original row could not be read
  // back — leaves an earlier attempt's outcome unknown, so the body must not
  // run on ANY plan: running it could repeat that attempt's effects (#788
  // review 5964206145). Unkeyed calls keep the plan-based rule below.
  if (!opened?.ok && spec.clientRequestId) throw new AiRequestNotFiled(spec.feature);
  // An exempt row is a record, not the meter, so its failed filing leaves no
  // hole in the allowance and the work goes on, as on an unlimited plan.
  if (!opened?.ok && plan.capped && !exempt) {
    // The row is not only diagnostics: on a capped plan it IS the meter (F19).
    // `monthlyAllowance` counts these rows, so a model call made without one
    // is a call the allowance never sees, and a family at 9 of 10 whose filing
    // failed stayed at 9 however often it called. On a capped plan the call is
    // refused instead; on an unlimited plan nothing is metered by the row, and
    // the family's work goes on as before, unrecorded. A capped plan whose
    // admission failed for any other reason — including `admit_ai_request` not
    // existing yet because this code deployed before 0477 — lands here too.
    throw new AiRequestNotFiled(spec.feature);
  }
  // The key named a request already filed: this is a retry of it, not a new
  // one. Its row is left exactly as it is (it belongs to the first attempt) and
  // nothing below runs.
  if (opened?.ok && opened.data.existing) throw new AiRequestDuplicate(spec.feature, opened.data.id);
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

/** The request row could not be filed on a plan whose allowance counts it (F19). */
export class AiRequestNotFiled extends Error {
  constructor(readonly feature: string) {
    super(`could not file the AI request for ${feature}; refused because the allowance counts it`);
    this.name = 'AiRequestNotFiled';
  }
}

/**
 * The family is at its monthly allowance (F19): the admission refused to file
 * the row and the body did not run. A subclass of `AiRequestNotFiled`, so every
 * caller that already stops on an unfiled request stops on this too; the
 * routes that answer allowance denials map it to their 429 `allowance_exceeded`.
 * The message is the allowance refusal `assertAIAccess` gives.
 */
export class AiRequestOverAllowance extends AiRequestNotFiled {
  readonly code = 'allowance_exceeded' as const;
  constructor(feature: string, readonly allowance: number) {
    super(feature);
    this.name = 'AiRequestOverAllowance';
    this.message = `Your family has used its ${allowance} AI requests for this month. Upgrade to Family Basic for unlimited, or try again next month.`;
  }
}

/** A retry key named a request already filed; the body did not run. */
export class AiRequestDuplicate extends Error {
  constructor(readonly feature: string, readonly requestId: string) {
    super(`${feature} request ${requestId} was already filed under this retry key`);
    this.name = 'AiRequestDuplicate';
  }
}

// How this family's request is filed. `capped`: the allowance is counted from
// `ai_requests`, so a failed filing refuses. `allowance`: the number the row is
// admitted against, or null to file it plainly.
//
// A plan that cannot be read is treated as capped — an allowance that cannot be
// checked is not an allowance, the rule `monthlyAllowance` follows — but with
// no number to admit against, so the row is filed plainly and only a failed
// filing refuses (the rule before admission existed). Admitting against the
// Free number instead would refuse a paying family over ten during a plan-read
// outage; the routes' own allowance check, which fails closed on the same read,
// has already run.
async function filingPlan(scope: ServiceScope): Promise<{ capped: boolean; allowance: number | null }> {
  try {
    const level = await resolveFamilyPlanLevel(scope.db, scope.familyId);
    const allowance = monthlyAllowanceFor(level);
    return { capped: allowance !== null, allowance };
  } catch (err) {
    console.error('[ai-observability] plan level read failed before filing', err);
    return { capped: true, allowance: null };
  }
}
