// lib/assistant/trust-wrapper.ts — intercepts every chat-tool execution and
// routes it through the shared AI gate (lib/trust/ai-gate.ts) before writing
// anything: the family's settings, the Trust & Permissions Engine, then the
// risk tier.
// allow → execute normally
// require_approval → create approval_request, return "pending" chip
// deny → return blocked result (no write happens)
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ToolSpec } from '@/lib/ai/provider';
import { roleOf } from '@/lib/trust/server';
import { gateAiAction } from '@/lib/trust/ai-gate';

type DB = SupabaseClient<Database>;

// Write tools that touch family data — all need a trust check.
// Read tools are intentionally absent; they pass through unchanged.
export const TOOL_DOMAIN: Record<string, string> = {
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

/**
 * Gated tools whose approval a parent can grant and Bubaly then cannot carry
 * out on its own.
 *
 * `gateAiAction` stores `{name, args}` as the approval's payload, and
 * `approveRequest` replays it with `executeTool(scope, name, args)`
 * (lib/services/approvals/index.ts). `executeTool` resolves the name through
 * the tool registry, so a name the registry does not know is DENIED at replay
 * and the parent reads "Approved, but Bubaly could not finish it: Bubaly has
 * no tool called ...".
 *
 * IT IS EMPTY, AND THAT IS THE POINT. It held `add_note`, `add_goal` and
 * `rsvp_to_event` — the three gated tools that were written nowhere but
 * `lib/assistant/tools.ts`. They now resolve to `notes.create`, `goals.create`
 * and `calendar.rsvp`, so every gated tool can be replayed and none needs a
 * caveat. Emptying it was forced rather than remembered:
 * `tests/assistant-approval-replay.test.ts` fails on an entry whose tool has
 * gained a registry equivalent.
 *
 * The list stays because the ratchet still needs somewhere to put the next one.
 * That test fails in both directions — a newly gated tool with no registry
 * equivalent has to be named here with a reason, and an entry that gains one
 * has to be removed.
 */
export const APPROVAL_CANNOT_REPLAY: Record<string, string> = {};

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

        // One gate for every AI surface (lib/trust/ai-gate.ts): the family's
        // settings, then the engine, then the risk tier. Chat used to call the
        // bare engine, so "Switch Bubaly off" and the autonomy dial — both set
        // in Settings → Bubaly AI — never reached the tools a family talks to.
        const outcome = await gateAiAction(supabase, familyId, {
          toolName: tool.name,
          domain,
          actorId: 'assistant',
          actorRole,
          agent: 'AI Assistant',
          title,
          // Payload stored so an approved request can be auto-executed later.
          payload: { name: tool.name, args },
        });

        if (outcome.effect === 'deny') {
          return { ok: false, error: `Blocked by household policy: ${outcome.reason}` };
        }
        if (outcome.effect === 'require_approval') {
          // "Sent for parent approval" has to name a row a parent can actually
          // find. `gateAiAction` files it and hands back its id; when the insert
          // failed there is no request, nothing was written, and nobody was
          // asked — so the honest answer is a failure, not a queue.
          if (!outcome.approvalId) {
            return { ok: false, error: `Bubaly could not send that for approval, so ${lower(title)} did not happen. Please try again.` };
          }
          // The shape matters: the card the family acts on is built by
          // `approvalIdFromToolResult` (lib/ai/result-cards.ts), which reads
          // snake_case `pending_approval` plus an `approval_id`. This used to
          // return camelCase `pendingApproval` and drop the id it had been
          // given, so every gated chat write said "sent for parent approval"
          // and rendered nothing anyone could approve from the thread. The
          // registry path already returns this shape
          // (lib/ai/tools/legacy-adapter.ts) — the wrapper was the odd one out.
          const caveat = APPROVAL_CANNOT_REPLAY[tool.name]
            ? ' Once a parent approves it they will need to add it by hand — Bubaly cannot finish this one on its own yet.'
            : '';
          return {
            ok: true,
            summary: `⏳ Sent for parent approval — ${title}.${caveat}`,
            pending_approval: true,
            approval_id: outcome.approvalId,
          };
        }

        // allow or auto_approve → execute normally
        return tool.execute(args);
      },
    };
  });
}

/** A title like `Add chore: "Bins"` read back inside a sentence. */
function lower(title: string): string {
  return title.charAt(0).toLowerCase() + title.slice(1);
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
