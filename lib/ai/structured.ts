// lib/ai/structured.ts — the only sanctioned way to get a decision out of a model.
//
// WHY: §5 forbids parsing important agent decisions out of free text, and the
// audit found ~20 features regex-scraping JSON from prose. A regex that "usually
// works" is a silent correctness bug — it produces a plan with a missing field,
// which the executor then acts on. This module makes the model's reply
// structurally impossible to misread:
//
//   1. the zod schema is converted to strict JSON Schema (lib/ai/schema-to-json.ts)
//      and sent as `response_format: {type:'json_schema', strict:true}`, so the
//      provider itself constrains generation;
//   2. the reply is re-validated locally with the same zod schema — never trust
//      the provider to have honoured the schema;
//   3. on a validation failure the model gets EXACTLY ONE repair round, with the
//      zod issues fed back verbatim. One round, because a model that cannot
//      satisfy its own schema twice will not do it on the third try, and each
//      round costs a user-visible second.
//
// Nothing here throws: a planner that crashes on a malformed reply is worse than
// one that reports "the model could not produce a valid plan". Transport-level
// failures are retried by lib/ai/retry.ts — safe here because a structured
// completion carries no tools and therefore has no side effects.

import type { ZodType } from 'zod';
import type { AIMessage, AIProvider } from '@/lib/ai/provider';
import { describeAIError } from '@/lib/ai/provider';
import { resolveProviderForTask, type AITask } from '@/lib/ai/routing';
import { RetryAbortedError, withBackoff } from '@/lib/ai/retry';
import { conformNulls, UnsupportedSchemaError, zodToStrictJsonSchema } from '@/lib/ai/schema-to-json';
import { addUsage, recordModelCall, type TokenUsage } from '@/lib/ai/usage';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export type StructuredResult<T> =
  | { ok: true; data: T; usage?: TokenUsage }
  | { ok: false; error: string; code: string };

/** Where to record token usage. Omit it and the call is simply not metered. */
export type StructuredMeter = {
  db: SupabaseClient<Database>;
  familyId: string;
  runId?: string | null;
  stepId?: string | null;
};

export type StructuredInput<T> = {
  schema: ZodType<T>;
  /** OpenAI requires /^[a-zA-Z0-9_-]+$/; use a stable name like 'family_plan'. */
  schemaName: string;
  system: string;
  messages: AIMessage[];
  /** Routing task. Defaults to 'plan' — the strong model — because the callers
   *  that need guaranteed structure are planners; cheap tasks pass their own. */
  task?: AITask;
  maxTokens?: number;
  requestId?: string | null;
  signal?: AbortSignal | null;
  /** Injected in tests and by the executor, which already holds a provider. */
  provider?: AIProvider;
  meter?: StructuredMeter | null;
};

/** How many issues to quote back to the model; enough to fix, short enough to read. */
const MAX_REPAIR_ISSUES = 12;

function issueSummary(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues
    .slice(0, MAX_REPAIR_ISSUES)
    .map((issue) => `- ${issue.path.length ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('\n');
}

/**
 * Ask a model for a value of `schema`. Returns a discriminated result and never
 * throws. `code` is one of: 'schema' (the zod schema cannot be expressed in
 * strict JSON Schema), 'refusal' (the model declined), 'invalid_json',
 * 'invalid_output' (schema violation that survived the repair round), or a
 * provider code from describeAIError ('quota', 'auth', 'rate_limit', 'model',
 * 'network', 'cancelled', 'unconfigured', 'unknown').
 */
export async function structured<T>(input: StructuredInput<T>): Promise<StructuredResult<T>> {
  const task: AITask = input.task ?? 'plan';

  let jsonSchema: Record<string, unknown>;
  try {
    jsonSchema = zodToStrictJsonSchema(input.schema);
  } catch (error) {
    const detail = error instanceof UnsupportedSchemaError ? error.message : String(error);
    console.error(`[ai-structured] ${input.schemaName} could not be converted to JSON Schema`, error);
    return { ok: false, code: 'schema', error: detail };
  }

  let provider: AIProvider;
  try {
    provider = input.provider ?? (await resolveProviderForTask(task));
  } catch (error) {
    const described = describeAIError(error);
    console.error(`[ai-structured] ${input.schemaName} could not resolve a provider`, error);
    return { ok: false, code: described.code, error: described.message };
  }

  const messages: AIMessage[] = [...input.messages];
  let usage: TokenUsage | null = null;

  // Two passes at most: the original request and one repair round (§5).
  for (let attempt = 0; attempt < 2; attempt++) {
    const startedAt = Date.now();
    let completion: Awaited<ReturnType<AIProvider['structuredCompletion']>>;
    try {
      completion = await withBackoff(
        () => provider.structuredCompletion({
          system: input.system,
          messages,
          schemaName: input.schemaName,
          jsonSchema,
          maxTokens: input.maxTokens,
          signal: input.signal ?? undefined,
        }),
        { signal: input.signal ?? null },
      );
    } catch (error) {
      const described = error instanceof RetryAbortedError
        ? { code: 'cancelled', message: 'That request was cancelled.' }
        : describeAIError(error);
      console.error(`[ai-structured] ${input.schemaName} provider call failed`, error);
      await meter(input, provider, task, null, Date.now() - startedAt, false, described.code);
      return { ok: false, code: described.code, error: described.message };
    }

    usage = addUsage(usage, completion.usage);
    await meter(input, provider, task, completion.usage, Date.now() - startedAt, true, null);

    if (completion.refusal) {
      // A refusal is a deliberate provider decision, not a formatting slip —
      // repairing it would just spend another call to be refused again.
      return { ok: false, code: 'refusal', error: completion.refusal };
    }

    const raw = completion.text ?? '';
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      if (attempt === 0) {
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: 'That reply was not valid JSON. Reply again with only the JSON object required by the schema.' });
        continue;
      }
      console.error(`[ai-structured] ${input.schemaName} returned non-JSON after repair`);
      return { ok: false, code: 'invalid_json', error: 'The AI returned a reply that was not valid JSON.' };
    }

    // Strict mode expresses "optional" as null; conformNulls maps those back to
    // the `undefined` zod expects before validating.
    const parsed = input.schema.safeParse(conformNulls(input.schema, decoded));
    if (parsed.success) return { ok: true, data: parsed.data, usage: usage ?? undefined };

    if (attempt === 0) {
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: `That reply did not match the required schema:\n${issueSummary(parsed.error)}\n\nReply again with only a corrected JSON object.`,
      });
      continue;
    }

    console.error(`[ai-structured] ${input.schemaName} failed validation after repair`, parsed.error.issues.slice(0, MAX_REPAIR_ISSUES));
    return { ok: false, code: 'invalid_output', error: 'The AI could not produce a reply in the required format.' };
  }

  // Unreachable: both loop passes either return or continue into the second.
  return { ok: false, code: 'invalid_output', error: 'The AI could not produce a reply in the required format.' };
}

/** Record one model call when the caller supplied a meter; never throws. */
async function meter<T>(
  input: StructuredInput<T>,
  provider: AIProvider,
  task: AITask,
  usage: TokenUsage | null,
  latencyMs: number,
  ok: boolean,
  errorCode: string | null,
): Promise<void> {
  if (!input.meter) return;
  try {
    await recordModelCall({
      db: input.meter.db,
      familyId: input.meter.familyId,
      requestId: input.requestId ?? null,
      runId: input.meter.runId ?? null,
      stepId: input.meter.stepId ?? null,
      model: provider.model,
      task,
      usage,
      latencyMs,
      ok,
      errorCode,
    });
  } catch (error) {
    console.error('[ai-structured] usage recording failed', error);
  }
}
