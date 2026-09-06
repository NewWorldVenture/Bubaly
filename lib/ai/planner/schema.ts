// lib/ai/planner/schema.ts — the shape a plan comes back from the model in.
//
// WHY it looks the way it does: this schema is sent to OpenAI as a strict
// `json_schema` (lib/ai/schema-to-json.ts), and strict mode has hard rules —
// every object must close itself (`additionalProperties:false`), every key must
// be in `required`, and keywords like `minLength`/`maxItems`/`pattern` are
// rejected outright. So:
//
//   - every object is `.strict()` and every "optional" field is `.nullable()`
//     and always present, never `.optional()`;
//   - no `.min()`, `.max()`, `.uuid()`, `.regex()` anywhere in this file — the
//     lengths that matter (a description, the reasoning summary) are enforced
//     AFTER the reply, in lib/ai/planner/validate.ts;
//   - a step's `input` is a JSON *string*. Each tool has its own input schema
//     and strict mode cannot express "an object whose shape depends on
//     `tool_name`", so the model writes the object as text and the validator
//     parses it and checks it against the registry tool's real zod schema. A
//     tool that gets malformed arguments is dropped from the plan, not called.
//
// The pure helpers at the bottom (`parseStepInput`, `encodeStepInput`,
// `decodeConditionValue`) are what make the string round trip testable without
// a model in the loop. No I/O, no `server-only`: tests import this directly.
import { z } from 'zod';

/**
 * The step kinds a model may emit. `replan` exists in the executor's vocabulary
 * (0250's CHECK) but is deliberately NOT offered here: the run executor in this
 * checkout has no re-planning port wired, so a model-emitted replan step would
 * block honestly instead of running. `lib/ai/planner/index.ts replanRun` is
 * the implementation for when the port is connected.
 */
export const PLAN_STEP_TYPES = ['retrieve', 'act', 'verify', 'notify', 'approval', 'followup'] as const;
export type PlanStepType = (typeof PLAN_STEP_TYPES)[number];

export const PLAN_RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type PlanRiskLevel = (typeof PLAN_RISK_LEVELS)[number];

/**
 * A step's run-time condition, mirroring `StepCondition` in
 * lib/ai/runs/executor.ts. `eq`/`ne` are JSON-encoded so a boolean or a number
 * survives strict mode (which has no "any" type) — `decodeConditionValue` turns
 * them back before the plan is saved.
 */
export const PlanConditionSchema = z.object({
  path: z.string().describe('Where to look in the results of the steps this one depends on, e.g. "deps[0].count" or "deps[1].verified"'),
  eq: z.string().nullable().describe('JSON-encoded value the path must equal, e.g. "true" or "0" or "\\"dinner\\""; null when unused'),
  ne: z.string().nullable().describe('JSON-encoded value the path must NOT equal; null when unused'),
  exists: z.boolean().nullable().describe('true = the path must be present, false = it must be absent; null when unused'),
}).strict();

export const PlanStepSchema = z.object({
  key: z.string().describe('Short unique handle for this step, e.g. "food_profile" or "grocery_list"; other steps refer to it in depends_on'),
  step_type: z.enum(PLAN_STEP_TYPES).describe('retrieve = read-only tool; act = tool that changes something; verify = re-check the result; notify = tell people; approval = wait for a person before continuing; followup = pause and continue later'),
  tool_name: z.string().nullable().describe('The exact tool name from the catalogue for retrieve/act steps; null for other step types'),
  description: z.string().describe('One plain sentence a family member reads on the run timeline, e.g. "Plan seven dinners around soccer nights"'),
  input: z.string().describe('The step\'s arguments as a JSON object encoded as a string, e.g. "{\\"title\\":\\"Dentist\\",\\"starts_at\\":\\"2026-09-12T09:00:00\\"}". Use "{}" when there are none. To use what an earlier step produced, put {"$fromStep":"<that step\'s key>","path":"id"} where the value goes — and list that key in depends_on'),
  depends_on: z.array(z.string()).describe('Keys of steps that must finish first. Independent retrieve steps should list none so they run in parallel'),
  condition: PlanConditionSchema.nullable().describe('Run this step only when the condition holds; null to always run'),
  approval_required: z.boolean().nullable().describe('true when a person should say yes before this runs; null to let household policy decide'),
  verify: z.string().nullable().describe('Optional JSON verification spec to run after this step. Prefer naming what THIS step wrote: "{\\"checks\\":[{\\"kind\\":\\"records_exist\\",\\"table\\":\\"calendar_events\\",\\"ids\\":[{\\"$fromStep\\":\\"the key of this step\\",\\"path\\":\\"id\\"}]}]}". A bare count proves nothing when the family already had rows. null for none'),
}).strict();

export const PlanFollowupSchema = z.object({
  after: z.string().describe('When to check back: an ISO 8601 instant, or a delay like "2d", "12h" or "45m"'),
  prompt: z.string().describe('What to check or do then, in plain words, e.g. "Confirm the packing lists are done"'),
}).strict();

export const PlanClarificationSchema = z.object({
  question: z.string().describe('The one short question to ask the person'),
  reason: z.string().describe('Why the answer changes the outcome — shown to the person'),
}).strict();

export const PlanSchema = z.object({
  objective: z.string().describe('What the family asked for, as one sentence in their words'),
  reasoning_summary: z.string().describe('Two or three plain sentences a family member reads: what you chose and why. Outcomes, not deliberation; never mention tools, modules or agents'),
  risk_level: z.enum(PLAN_RISK_LEVELS).describe('Your estimate; the household policy recomputes it'),
  steps: z.array(PlanStepSchema).describe('The execution graph. Empty when the request needs no action (see answer/clarification)'),
  followups: z.array(PlanFollowupSchema).describe('Later check-ins this request needs; usually empty'),
  clarification: PlanClarificationSchema.nullable().describe('Set ONLY when a missing fact would materially change the outcome and the household context does not answer it; otherwise null'),
  answer: z.string().nullable().describe('For a pure question with nothing to execute: the answer in plain words. Otherwise null'),
}).strict();

export type PlanCondition = z.infer<typeof PlanConditionSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanFollowup = z.infer<typeof PlanFollowupSchema>;
export type PlanClarification = z.infer<typeof PlanClarificationSchema>;
export type Plan = z.infer<typeof PlanSchema>;

/** The `schemaName` OpenAI echoes back; must match /^[a-zA-Z0-9_-]+$/. */
export const PLAN_SCHEMA_NAME = 'family_plan';

/** Post-parse limits (strict mode cannot carry them). */
export const MAX_DESCRIPTION_CHARS = 200;
export const MAX_REASONING_CHARS = 700;
export const MAX_OBJECTIVE_CHARS = 200;
export const MAX_STEPS = 40;
export const MAX_FOLLOWUPS = 5;

export type StepInputParse =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Decode a step's `input` string into the object the tool schema will check.
 * Empty and whitespace-only inputs mean "no arguments" rather than an error,
 * because a retrieve step with no parameters is common and a model that writes
 * `""` for it should not lose the step.
 */
export function parseStepInput(input: string | null | undefined): StepInputParse {
  const text = (input ?? '').trim();
  if (!text) return { ok: true, value: {} };
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { ok: false, error: 'input is not valid JSON' };
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return { ok: false, error: 'input must be a JSON object' };
  }
  return { ok: true, value: decoded as Record<string, unknown> };
}

/** The inverse of `parseStepInput`, for templates and tests that author steps in code. */
export function encodeStepInput(value: Record<string, unknown> | null | undefined): string {
  return JSON.stringify(value ?? {});
}

/**
 * A condition value as the executor compares it. JSON-encoded values decode to
 * their real type; a bare word the model forgot to quote stays a string, which
 * is what it most likely meant.
 */
export function decodeConditionValue(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * The executor-shaped condition (`{path, eq?, ne?, exists?}`), or null when the
 * model set none. Keys with a null value are dropped: `evaluateCondition`
 * treats `eq: undefined` as "no comparison" but `eq: null` as "must equal
 * null", and only the former is what a null slot means here.
 */
export function toExecutorCondition(condition: PlanCondition | null | undefined): Record<string, unknown> | null {
  if (!condition) return null;
  const path = condition.path.trim();
  if (!path) return null;
  const out: Record<string, unknown> = { path };
  if (condition.exists !== null && condition.exists !== undefined) out.exists = condition.exists;
  else if (condition.eq !== null && condition.eq !== undefined) out.eq = decodeConditionValue(condition.eq);
  else if (condition.ne !== null && condition.ne !== undefined) out.ne = decodeConditionValue(condition.ne);
  else return null;
  return out;
}
