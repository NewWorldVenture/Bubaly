// The vocabulary every AI-callable tool is written in.
//
// A tool is the ONLY way the assistant is allowed to change household data.
// Everything the executor needs to gate, deduplicate, audit and describe a
// call therefore lives on the definition itself rather than in a lookup table
// somewhere else: the trust `domain`/`capability` (so `lib/trust/engine.ts` can
// evaluate it), an honest `risk` tier (§12), zod schemas on BOTH sides, and a
// `summarize` that produces the line a family actually reads.
//
// WHY zod on the output as well as the input: §13 says execution is not
// success. A service that returns a row shaped differently from what the tool
// promised is a bug the model would otherwise narrate as a success, so the
// output is validated before the outcome is reported and before the ledger
// records it.
//
// WHY `summarize` takes no scope: a summary is written once, from data the
// tool already returned, and must read identically wherever it is replayed —
// the run timeline, the activity feed, an approval card, a chat bubble. Any
// value that depends on the family's timezone (a time, a day) is therefore
// resolved into the OUTPUT by `execute`, which does have the scope, and the
// summary only composes strings. `describeWhen` below is that resolver.
import type { ZodType } from 'zod';
import type { ServiceResult, ServiceScope } from '@/lib/services/types';
import type { Capability, TrustDomain } from '@/lib/trust/engine';

/**
 * §12's three classes. `low` is the work a family wants done without being
 * asked twice (add an event, add a task), `medium` changes or removes
 * something that already existed, `high` is destructive, expensive or hard to
 * walk back and always wants a person.
 */
export type RiskLevel = 'low' | 'medium' | 'high';

export type ToolDefinition<I = unknown, O = unknown> = {
  /** Canonical dotted name, e.g. 'calendar.createEvent'. */
  name: string;
  /**
   * Legacy flat names (`create_calendar_event`, `add_todo`, …). Stored
   * `approval_requests.payload.name` values and every existing caller use
   * these, so they must keep resolving to the same tool forever.
   */
  aliases?: string[];
  description: string;
  input: ZodType<I>;
  output: ZodType<O>;
  domain: TrustDomain;
  /**
   * The capability a MEMBER performing this by hand would need. AI and system
   * actors are evaluated as `automate` with an `op:<capability>` tag, because
   * every `subject_kind='ai'` policy (the autopilot dial, §4.6's category
   * policies) is written against `automate`; see `lib/ai/tools/execute.ts`.
   */
  capability: Capability;
  risk: RiskLevel;
  /** True when the tool cannot change anything. Read tools skip the write gate. */
  readOnly: boolean;
  /**
   * A stable key for "this exact call". When two calls produce the same key in
   * one family, the second returns the first one's result instead of writing
   * again. Return null when the call is inherently repeatable.
   */
  idempotencyFrom?: (input: I, scope: ServiceScope) => string | null;
  /** One line a family member reads without context: "Added soccer at 9:00 AM Saturday". */
  summarize: (input: I, output: O) => string;
  /** What approving this would cause. Shown on the approval card (§31). */
  consequences?: (input: I) => string[];
  execute: (scope: ServiceScope, input: I) => Promise<ServiceResult<O>>;
  /**
   * §13: re-read the world and confirm the change is really there. Runs after
   * a successful execute; its verdict rides along on the outcome rather than
   * turning a committed write back into a failure.
   */
  verify?: (scope: ServiceScope, input: I, output: O) => Promise<ServiceResult<{ verified: boolean; detail: string }>>;

  // ── Executor hints (additive to the shared contract; both optional) ───────
  /**
   * Who writes the `agent_activity` line. Several domain services already
   * record one with domain-specific copy (`lib/services/calendar` and friends
   * call `recordActivitySafely` after a committed write); those tools declare
   * `'service'` so the executor does not add a second, blander entry to the
   * same feed. Everything else defaults to `'executor'`.
   */
  activityFrom?: 'service' | 'executor';
  /**
   * The row this call created or changed, for `ai_tool_calls.resource_table` /
   * `resource_id` — what makes a ledger entry point at the thing it produced.
   */
  resource?: (output: O) => { table: string; id: string | null } | null;
};

/**
 * The result of one tool invocation. `pending_approval` is a real outcome, not
 * an error: the approval row holds the payload, so the work resumes when a
 * parent says yes.
 */
export type ToolOutcome =
  | { status: 'ok'; data: unknown; summary: string; toolCallId: string | null; verified?: boolean }
  | { status: 'pending_approval'; approvalId: string | null; summary: string; toolCallId: string | null }
  | { status: 'denied'; reason: string; toolCallId: string | null }
  | { status: 'error'; error: string; retryable: boolean; toolCallId: string | null };

/**
 * Author a tool with full inference, store it as an opaque one.
 *
 * The registry holds `ToolDefinition<unknown, unknown>` so `getTool` can return
 * a single type, but `execute(scope, input: Concrete)` is contravariant in its
 * input and so is not assignable to `execute(scope, input: unknown)`. This
 * helper is the one place that erasure happens — the argument is still checked
 * against the concrete schema types, so a tool whose `execute` disagrees with
 * its `input` schema still fails to compile.
 */
export function defineTool<I, O>(def: ToolDefinition<I, O>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

/**
 * "Saturday at 9:00 AM" / "Sat 13 Dec at 9:00 AM" in the family's zone.
 *
 * Weekday-only inside the coming week, because that is how a person says it;
 * beyond that the date is needed for the sentence to mean anything. Falls back
 * to the raw value rather than throwing — a summary is never worth failing a
 * committed write over.
 */
export function describeWhen(iso: string | null | undefined, tz: string, now: Date = new Date()): string {
  if (!iso) return 'no set time';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const at = new Date(ms);
  const withinAWeek = ms - now.getTime() < 6 * 24 * 3600_000 && ms - now.getTime() > -12 * 3600_000;
  try {
    const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(at);
    const day = withinAWeek
      ? new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(at)
      : new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(at);
    return `${time} ${day}`;
  } catch {
    return at.toISOString();
  }
}

/** "Saturday" / "Sat, Dec 13" in the family's zone — for all-day things that have no clock time. */
export function describeDay(iso: string | null | undefined, tz: string, now: Date = new Date()): string {
  if (!iso) return 'no set day';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const at = new Date(ms);
  const withinAWeek = ms - now.getTime() < 6 * 24 * 3600_000 && ms - now.getTime() > -12 * 3600_000;
  try {
    return withinAWeek
      ? new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(at)
      : new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** `3 items` / `1 item` — plural agreement is the difference between a sentence and a log line. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
