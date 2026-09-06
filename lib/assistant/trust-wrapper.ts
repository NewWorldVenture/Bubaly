// lib/assistant/trust-wrapper.ts — intercepts every chat-tool execution and
// routes it through the Trust & Permissions Engine before writing anything.
// allow → execute normally
// require_approval → create approval_request, return "pending" chip
// deny → return blocked result (no write happens)
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ToolSpec } from '@/lib/ai/provider';
import { evaluateTrust, roleOf } from '@/lib/trust/server';

type DB = SupabaseClient<Database>;

// Write tools that touch family data — all need a trust check.
// Read tools are intentionally absent; they pass through unchanged.
const TOOL_DOMAIN: Record<string, string> = {
  create_calendar_event: 'calendar',
  add_chore: 'chores',
  add_grocery_item: 'shopping',
  add_todo: 'tasks',
  add_reminder: 'scheduling',
  // Both of these mutate family_reminders (one of them inserts the next
  // occurrence of a repeating reminder), so both belong here. They shadow the
  // gated registry tools of the same name via `mergeToolSets`, which is why
  // leaving them out meant two writes reaching the database ungated.
  complete_reminder: 'scheduling',
  snooze_reminder: 'scheduling',
  add_note: 'tasks',
  add_goal: 'tasks',
  create_announcement: 'announcements',
  rsvp_to_event: 'calendar',
};

export function wrapToolsWithTrust(
  tools: ToolSpec[],
  supabase: DB,
  familyId: string,
  memberRole: string | null | undefined,
): ToolSpec[] {
  const actorRole = roleOf(memberRole);

  return tools.map((tool) => {
    const domain = TOOL_DOMAIN[tool.name];
    if (!domain) return tool; // read tools and unrecognised names skip trust

    return {
      ...tool,
      execute: async (args: Record<string, unknown>) => {
        const title = fmtTitle(tool.name, args);

        const { decision } = await evaluateTrust(supabase, familyId, {
          actor: { kind: 'ai_agent', id: 'assistant', role: actorRole },
          domain,
          capability: 'automate',
          agent: 'AI Assistant',
          title,
          // Payload stored so an approved request can be auto-executed later.
          payload: { name: tool.name, args },
          context: { confidence: 0.85 },
        });

        if (decision.effect === 'deny') {
          return { ok: false, error: `Blocked by household policy: ${decision.reason}` };
        }
        if (decision.effect === 'require_approval') {
          return {
            ok: true,
            summary: `⏳ Sent for parent approval — ${title}`,
            pendingApproval: true,
          };
        }

        // allow or auto_approve → execute normally
        return tool.execute(args);
      },
    };
  });
}

function fmtTitle(name: string, a: Record<string, unknown>): string {
  const s = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
  switch (name) {
    case 'create_calendar_event': return `Add event: "${s('title')}"`;
    case 'add_chore':             return `Add chore: "${s('title')}"`;
    case 'add_grocery_item':      return `Add grocery: ${s('item')}`;
    case 'add_todo':              return `Add task: "${s('task')}"`;
    case 'add_reminder':          return `Add reminder: "${s('title')}"`;
    case 'complete_reminder':     return `Complete reminder: "${s('title')}"`;
    case 'snooze_reminder':       return `Move reminder: "${s('title')}"`;
    case 'add_note':              return `Save note: "${s('title') || s('body').slice(0, 40)}"`;
    case 'add_goal':              return `Create goal: "${s('title')}"`;
    case 'create_announcement':   return `Post announcement: "${s('title')}"`;
    case 'rsvp_to_event':         return `RSVP ${s('status')} to "${s('event_title')}"`;
    default:                      return name;
  }
}
