// Registry entries → the `ToolSpec[]` that `lib/ai/provider.ts runTools`
// already consumes, so `/api/ai` keeps working while the callers are migrated.
//
// TWO THINGS THIS FILE EXISTS TO GET RIGHT:
//
//   1. NAMES. OpenAI function names must match /^[a-zA-Z0-9_-]+$/, so the
//      dotted canonical name cannot go on the wire. The spec sent to the model
//      uses the underscored form (`calendar_createEvent`), which the registry
//      resolves back to the same tool — as it does the legacy flat names, so a
//      transcript or a stored payload from either era still executes.
//
//   2. RESULTS. The provider's tool loop feeds whatever `execute` returns back
//      into the conversation as the tool result, and the model narrates it. So
//      a denial has to come back as `{ok:false}` with the household's reason
//      (otherwise the model cheerfully reports success), and a pending
//      approval has to be visibly neither — it is `ok:true` with
//      `pending_approval`, because the request was handled correctly even
//      though nothing changed yet.
import 'server-only';
import type { ToolSpec } from '@/lib/ai/provider';
import { UnsupportedSchemaError, zodToStrictJsonSchema } from '@/lib/ai/schema-to-json';
import type { ServiceScope } from '@/lib/services/types';
import { executeTool } from './execute';
import { functionName, listTools } from './registry';
import type { ToolDefinition } from './types';

export type LegacyToolResult =
  | { ok: true; summary: string; data?: unknown; verified?: boolean; tool_call_id?: string | null }
  | { ok: true; summary: string; pending_approval: true; approval_id: string | null }
  | { ok: false; error: string };

/** The JSON Schema for one tool, or null when its zod schema cannot be expressed. */
export function toolInputSchema(tool: ToolDefinition): Record<string, unknown> | null {
  try {
    return zodToStrictJsonSchema(tool.input);
  } catch (error) {
    // A tool we cannot describe is a tool the model cannot call correctly, so
    // it is left out rather than offered with a schema that does not match.
    // `tests/tool-registry.test.ts` asserts this never happens in practice.
    const detail = error instanceof UnsupportedSchemaError ? error.message : String(error);
    console.error(`[tool-adapter] ${tool.name} has no expressible input schema: ${detail}`);
    return null;
  }
}

/**
 * Every registry tool as a `ToolSpec` bound to one family's scope.
 *
 * `names` accepts canonical, underscored or legacy spellings, so a caller that
 * still holds a list of flat names can narrow the toolbox without translating.
 */
export function toToolSpecs(scope: ServiceScope, opts: { names?: string[] } = {}): ToolSpec[] {
  const specs: ToolSpec[] = [];
  for (const tool of listTools({ names: opts.names })) {
    const schema = toolInputSchema(tool);
    if (!schema) continue;
    specs.push({
      name: functionName(tool.name),
      description: tool.description,
      input_schema: schema,
      execute: async (args: Record<string, unknown>): Promise<LegacyToolResult> => {
        const outcome = await executeTool(scope, tool.name, args);
        switch (outcome.status) {
          case 'ok':
            return {
              ok: true,
              summary: outcome.summary,
              data: outcome.data,
              ...(outcome.verified === undefined ? {} : { verified: outcome.verified }),
              tool_call_id: outcome.toolCallId,
            };
          case 'pending_approval':
            return { ok: true, summary: outcome.summary, pending_approval: true, approval_id: outcome.approvalId };
          case 'denied':
            return { ok: false, error: outcome.reason };
          default:
            return { ok: false, error: outcome.error };
        }
      },
    });
  }
  return specs;
}
