// One capability, one name on the wire.
//
// `lib/ai/assistant-engine.ts` offers the model three tool sets merged by name,
// earlier wins, and keeps the registry from duplicating a hand-written tool
// with this:
//
//     const covered = new Set([...assistantTools, ...actionTools].map((t) => getTool(t.name)?.name)…)
//     toToolSpecs(scope, { names: toolNames().filter((n) => !covered.has(n)) })
//
// `mergeToolSets` dedupes on the WIRE name, and the registry's wire name for
// `notes.create` is `notes_create` — a different string from `add_note`, which
// it can never see as the same tool. So the ALIAS is the whole mechanism: it is
// what makes `getTool('add_note')` resolve, which is what puts `notes.create`
// into `covered`, which is what keeps it out of set 3.
//
// Drop or misspell one alias and the model is offered BOTH spellings of one
// capability. That is not a cosmetic duplicate: the flat name goes through
// `wrapToolsWithTrust` (TOOL_DOMAIN) while the underscored one skips the
// wrapper and is gated inside `executeTool`, and only the underscored one
// writes an `ai_tool_calls` row. Two doors, two gates, one ledger — and nothing
// else in the suite would notice.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { buildAssistantTools } from '@/lib/assistant/tools';
import { buildActionTools, mergeToolSets } from '@/lib/ai/action-tools';
import { toToolSpecs } from '@/lib/ai/tools/legacy-adapter';
import { functionName, getTool, toolNames } from '@/lib/ai/tools/registry';
import { APPROVAL_CANNOT_REPLAY, TOOL_DOMAIN } from '@/lib/assistant/trust-wrapper';
import type { ServiceScope } from '@/lib/services/types';

// Neither the specs' construction nor the merge touches the database — only a
// tool's `execute` would, and nothing here calls one.
const db = { from: () => ({}) } as unknown as SupabaseClient<Database>;
const scope = {
  db, familyId: 'fam-1', userId: 'auth-user-1', memberId: 'member-1',
  role: 'parent', actorKind: 'ai', tz: 'UTC',
} as unknown as ServiceScope;

/** The exact merge lib/ai/assistant-engine.ts performs, in the same order. */
function mergedToolbox(): string[] {
  const assistantTools = buildAssistantTools(db, {
    familyId: 'fam-1', userId: 'auth-user-1', memberId: 'member-1',
    members: [{ id: 'member-1', display_name: 'Emma' }], tz: 'UTC',
  });
  const actionTools = buildActionTools({ supabase: db, familyId: 'fam-1', userId: 'auth-user-1' });
  const covered = new Set(
    [...assistantTools, ...actionTools]
      .map((tool) => getTool(tool.name)?.name)
      .filter((name): name is string => Boolean(name)),
  );
  const registryTools = toToolSpecs(scope, { names: toolNames().filter((name) => !covered.has(name)) });
  return mergeToolSets(assistantTools, actionTools, registryTools).map((t) => t.name);
}

describe('the model is never offered one capability twice', () => {
  it('offers no name twice', () => {
    const names = mergedToolbox();
    expect(new Set(names).size, `duplicate wire names: ${names.filter((n, i) => names.indexOf(n) !== i).join(', ')}`).toBe(names.length);
  });

  it('offers no capability under both its flat and its underscored spelling', () => {
    // The real failure mode. `add_note` and `notes_create` are different
    // strings, so the duplicate-name check above would pass while the model saw
    // one capability behind two differently-gated doors.
    const offered = new Set(mergedToolbox());
    const doubled: string[] = [];
    for (const name of offered) {
      const canonical = getTool(name)?.name;
      if (!canonical) continue;
      for (const spelling of [canonical, functionName(canonical)]) {
        if (spelling !== name && offered.has(spelling)) doubled.push(`${name} + ${spelling}`);
      }
    }
    expect([...new Set(doubled)], 'one capability offered under two names').toEqual([]);
  });

  it('every gated hand-written write either resolves or is a named orphan', () => {
    // The alias check stated positively. A gated tool whose alias is missing is
    // BOTH an approval that cannot replay and a duplicate in the toolbox — the
    // one deliberate exception is rsvp_to_event, which has no registry tool ON
    // PURPOSE (see APPROVAL_CANNOT_REPLAY).
    const unresolved = Object.keys(TOOL_DOMAIN)
      .filter((name) => !getTool(name) && !(name in APPROVAL_CANNOT_REPLAY));
    expect(unresolved, `gated but unknown to the registry: ${unresolved.join(', ')}`).toEqual([]);
  });

  it('keeps the hand-written tool in front, so its schema is what the model sees', () => {
    // Precedence matters as much as de-duplication: set 1 wins, so the wire
    // name stays the flat one the model has been prompted in for months and the
    // stored approval payloads keep matching.
    const offered = new Set(mergedToolbox());
    for (const name of ['add_note', 'add_goal', 'rsvp_to_event', 'add_chore', 'create_calendar_event']) {
      expect(offered.has(name), `${name} is no longer what the model is offered`).toBe(true);
    }
    for (const name of ['notes_create', 'goals_create']) {
      expect(offered.has(name), `${name} leaked into the toolbox alongside its flat name`).toBe(false);
    }
  });

  it('the two new tools are registered and reachable by their legacy names', () => {
    expect(getTool('add_note')?.name).toBe('notes.create');
    expect(getTool('add_goal')?.name).toBe('goals.create');
  });

  it('declares medium risk, because that is what the chat gate already applied', () => {
    // lib/trust/ai-gate.ts reads `registryTool ? effectiveRisk(settings, tool) : 'medium'`.
    // Before these tools existed the three names took the hard-coded fallback,
    // so declaring 'low' here — which every other tasks.* tool declares — would
    // have quietly loosened the gate for children the day this merged.
    for (const name of ['add_note', 'add_goal']) {
      expect(getTool(name)?.risk, `${name} would move the chat gate`).toBe('medium');
    }
  });
});
