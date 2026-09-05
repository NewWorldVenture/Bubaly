// lib/ai/action-tools.ts — exposes lib/ai/actions.ts to the agentic assistant.
//
// `AI_TOOLS` + `runAction` are the family-scoped Supabase writes the AI can
// perform (also used by Magic Import and approved trust-queue requests). This
// adapter turns each of them into a `ToolSpec` the provider's tool loop can
// execute, so the /api/ai route genuinely runs lib/ai/actions.ts rather than a
// parallel implementation.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ToolSpec } from '@/lib/ai/provider';
import { AI_TOOLS, runAction } from '@/lib/ai/actions';

type DB = SupabaseClient<Database>;

export type ActionToolContext = { supabase: DB; familyId: string; userId: string };

/** Every lib/ai/actions.ts tool as an executable ToolSpec, minus any excluded names. */
export function buildActionTools(ctx: ActionToolContext, opts: { exclude?: Iterable<string> } = {}): ToolSpec[] {
  const skip = new Set(opts.exclude ?? []);
  return AI_TOOLS.filter((tool) => !skip.has(tool.name)).map((tool) => ({
    ...tool,
    execute: (args: Record<string, unknown>) => runAction(ctx, { name: tool.name, args }),
  }));
}

/**
 * Merge tool sets by name. Earlier sets win, so the richer assistant toolbox
 * (member resolution, RSVP, availability) keeps precedence over the simpler
 * action bridge when both implement the same capability.
 */
export function mergeToolSets(...sets: ToolSpec[][]): ToolSpec[] {
  const seen = new Set<string>();
  const merged: ToolSpec[] = [];
  for (const set of sets) {
    for (const tool of set) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      merged.push(tool);
    }
  }
  return merged;
}
