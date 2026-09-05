// lib/ai/assistant-engine.ts — the agentic family assistant, as a reusable
// engine behind the canonical /api/ai route.
//
// One turn = load the family snapshot + conversation history, build the tool
// set (the assistant toolbox, the lib/ai/actions.ts bridge, and the rest of the
// `lib/ai/tools` registry — trust-wrapped for the caller's role), run the
// provider's tool loop, then persist both turns. Two transports share the exact
// same preparation and persistence:
//   - SSE stream (web): `action` chips as tools fire, `delta` text chunks, `done`.
//   - JSON (mobile, scripts): one response with the final text + action summaries.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { resolveProvider, describeAIError, type AIMessage, type AIProvider, type ToolSpec } from '@/lib/ai/provider';
import { buildAssistantTools } from '@/lib/assistant/tools';
import { wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';
import { buildActionTools, mergeToolSets } from '@/lib/ai/action-tools';
import { toToolSpecs } from '@/lib/ai/tools/legacy-adapter';
import { getTool, toolNames } from '@/lib/ai/tools/registry';
import type { MemberRole } from '@/lib/constants/roles';
import type { ServiceScope } from '@/lib/services/types';
import { describeActionError } from '@/lib/supabase/errors';

type DB = SupabaseClient<Database>;
type MessageInsert = Database['public']['Tables']['ai_messages']['Insert'];
type ConversationUpdate = Database['public']['Tables']['ai_conversations']['Update'];

export const ASSISTANT_MAX_TOKENS = 1500;

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const;

/** JSON when asked for explicitly; SSE otherwise (the web client's default). */
export function wantsJsonTransport(
  req: { headers: Headers; nextUrl: { searchParams: URLSearchParams } },
  body: Record<string, unknown>,
): boolean {
  if (req.nextUrl.searchParams.get('mode') === 'json') return true;
  if (body.stream === false) return true;
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/event-stream')) return false;
  return accept.includes('application/json');
}

export type AssistantTurnInput = {
  supabase: DB;
  familyId: string;
  userId: string;
  /** The caller's family role — drives the trust wrapper (approval queue for kids/teens). */
  role: string | null | undefined;
  familyName: string;
  tz: string;
  conversationId: string;
  message: string;
};

export type ExecutedAssistantAction = { name: string; args: Record<string, unknown>; result: unknown };
export type AssistantActionSummary = { name: string; ok: boolean; summary: string };

export type PreparedAssistantTurn = {
  system: string;
  messages: AIMessage[];
  tools: ToolSpec[];
  provider: AIProvider;
};

/** Pull a friendly summary + ok flag out of a tool result for the UI. */
export function summarizeToolResult(result: unknown): { ok: boolean; summary: string } {
  if (result && typeof result === 'object') {
    const r = result as { ok?: boolean; summary?: string; error?: string };
    if (r.ok === false) return { ok: false, summary: r.error ?? 'That didn’t work.' };
    return { ok: true, summary: r.summary ?? 'Done.' };
  }
  return { ok: true, summary: 'Done.' };
}

/** The assistant's final text, with a sensible fallback when the model only acted. */
export function finalizeAssistantContent(text: string, actionCount: number): string {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  return actionCount ? 'Done — I’ve updated that for you.' : 'I’m not sure how to help with that yet.';
}

export type FamilySnapshot = {
  familyName: string;
  tz: string;
  members: { display_name: string; role: string }[];
  events: { title: string; starts_at: string }[];
  openChores: number;
  meals: { name: string }[];
  now?: Date;
};

export function buildAssistantSystemPrompt(snapshot: FamilySnapshot): string {
  const { tz } = snapshot;
  const now = snapshot.now ?? new Date();
  const fmtDate = (iso: string) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
    } catch {
      return iso.slice(0, 16);
    }
  };
  const nowLocal = (() => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now);
    } catch {
      return now.toISOString();
    }
  })();

  const context = [
    `Family: ${snapshot.familyName}`,
    `Time zone: ${tz}. Current local date/time: ${nowLocal}.`,
    `Members: ${snapshot.members.map((m) => `${m.display_name} (${m.role})`).join(', ') || 'none'}`,
    `Upcoming events: ${snapshot.events.map((e) => `${e.title} — ${fmtDate(e.starts_at)}`).join('; ') || 'none'}`,
    `Open chores: ${snapshot.openChores}`,
    `Saved meals: ${snapshot.meals.map((m) => m.name).join(', ') || 'none'}`,
  ].join('\n');

  return [
    "You are Bubaly's family assistant — a warm, sharp, proactive chief of staff for this household.",
    'You can take real actions with the provided tools (calendar, chores, grocery list, to-dos, reminders, notes, goals, meal plan).',
    'Some tools are named `domain_action` (for example `calendar_updateEvent`, `tasks_assignTodo`, `groceries_checkItem`). They are ordinary tools — use them the same way, and prefer the one that matches the request exactly over a close-enough alternative.',
    'Guidelines:',
    "- When the user asks you to schedule, add, remind, or plan something, USE the tools to actually do it — don't just describe it.",
    '- Resolve relative dates ("tomorrow", "next Friday at 3pm") against the current local date/time and pass ISO 8601 datetimes in the family time zone.',
    '- You may call several tools in one turn (e.g. add multiple grocery items). Prefer one tool call per item.',
    '- After acting, confirm crisply what you did. If you need a critical detail (like a date), ask one short question instead of guessing.',
    '- Be concise, friendly, and genuinely helpful. Never invent data you were not given.',
    '',
    'Current family context:',
    context,
  ].join('\n');
}

/**
 * Load everything a turn needs. Returns a tagged failure (never throws for
 * data errors) so routes can answer with a precise status.
 */
export async function prepareAssistantTurn(input: AssistantTurnInput): Promise<
  { ok: true; turn: PreparedAssistantTurn } | { ok: false; error: string }
> {
  const { supabase, familyId, userId, conversationId, message } = input;
  const nowIso = new Date().toISOString();
  const [
    { data: history, error: historyError },
    { data: members, error: membersError },
    { data: events, error: eventsError },
    { data: chores, error: choresError },
    { data: meals, error: mealsError },
  ] = await Promise.all([
    supabase.from('ai_messages').select('role, content').eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(40),
    // `user_id` is selected so the acting member can be picked out of the roster
    // the snapshot already needs — the tool registry scopes writes by
    // `family_members.id`, not by the auth user id.
    supabase.from('family_members').select('id, user_id, display_name, role').eq('family_id', familyId).eq('is_active', true),
    supabase.from('calendar_events').select('title, starts_at, category').eq('family_id', familyId).gte('starts_at', nowIso).order('starts_at').limit(12),
    supabase.from('chore_assignments').select('status').eq('family_id', familyId).in('status', ['todo', 'in_progress']),
    supabase.from('meals').select('name, meal_type').eq('family_id', familyId).limit(5),
  ]);
  const contextError = historyError ?? membersError ?? eventsError ?? choresError ?? mealsError;
  if (contextError) {
    console.error('[assistant-engine] family context load failed', contextError);
    return { ok: false, error: describeActionError(contextError, 'Could not load the family assistant context.') };
  }

  const memberRows = (members ?? []).map((m) => ({ id: m.id, display_name: m.display_name }));
  const system = buildAssistantSystemPrompt({
    familyName: input.familyName,
    tz: input.tz,
    members: (members ?? []).map((m) => ({ display_name: m.display_name, role: m.role })),
    events: (events ?? []).map((e) => ({ title: e.title, starts_at: e.starts_at })),
    openChores: chores?.length ?? 0,
    meals: (meals ?? []).map((m) => ({ name: m.name })),
  });

  const messages: AIMessage[] = [
    ...(history ?? []).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: message },
  ];

  // Three sets, in precedence order, merged by name — earlier wins.
  //
  //   1. The assistant toolbox: the tools with chat-specific behaviour the
  //      registry has no equivalent for (member-name resolution, RSVP, pending
  //      decisions, announcements).
  //   2. `lib/ai/actions.ts`: what neither of the others covers — meal planning.
  //      Its registry-covered names now run through `executeTool` inside
  //      `runAction`, so this set is a name bridge, not a second implementation.
  //   3. Everything else in the registry. Without this the 20-odd tools the
  //      registry added over the old toolbox (change or cancel an event, find a
  //      conflict, assign a task or chore, check something off the shopping
  //      list, notify one person) would be reachable only from the run
  //      executor — built, tested, and unreachable from the one surface a
  //      family actually talks to. They arrive already gated and ledgered,
  //      because `executeTool` does both.
  //
  // A registry tool whose canonical name is ALREADY covered by set 1 or 2 is
  // excluded rather than merged: the two spellings (`create_calendar_event` and
  // `calendar_createEvent`) are different strings, so `mergeToolSets` could not
  // see them as one tool, and the model would be offered the same capability
  // twice under two names.
  const assistantTools = buildAssistantTools(supabase, { familyId, userId, members: memberRows, tz: input.tz });
  const actionTools = buildActionTools({ supabase, familyId, userId });
  const covered = new Set(
    [...assistantTools, ...actionTools]
      .map((tool) => getTool(tool.name)?.name)
      .filter((name): name is string => Boolean(name)),
  );
  const acting = (members ?? []).find((m) => m.user_id === userId) ?? null;
  if (!acting) {
    // The route resolves the caller through `requireUserContext` before getting
    // here, so this means the roster and the session disagree. The turn still
    // runs — refusing to answer would be a worse failure than an unattributed
    // write — but the services will record no `created_by`, so say so.
    console.error('[assistant-engine] no active family_members row for the caller', { familyId, userId });
  }
  const scope: ServiceScope = {
    db: supabase,
    familyId,
    userId,
    memberId: acting?.id ?? null,
    role: (acting?.role ?? input.role ?? 'adult') as MemberRole,
    actorKind: 'ai',
    tz: input.tz,
  };
  const registryTools = toToolSpecs(scope, { names: toolNames().filter((name) => !covered.has(name)) });
  const tools = wrapToolsWithTrust(
    mergeToolSets(assistantTools, actionTools, registryTools),
    supabase, familyId, input.role,
  );

  const provider = await resolveProvider();
  return { ok: true, turn: { system, messages, tools, provider } };
}

/** Persist both turns + structured actions and refresh the conversation metadata. */
export async function persistAssistantTurn(
  supabase: DB,
  args: { familyId: string; conversationId: string; message: string; assistantContent: string; actions: ExecutedAssistantAction[]; model: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { familyId, conversationId, message, assistantContent, actions, model } = args;
  const rows: MessageInsert[] = [
    { family_id: familyId, conversation_id: conversationId, role: 'user', content: message },
    {
      family_id: familyId, conversation_id: conversationId, role: 'assistant', content: assistantContent,
      tool_calls: actions.length ? (actions.map((a) => ({ name: a.name, args: a.args })) as unknown as MessageInsert['tool_calls']) : null,
      tool_results: actions.length ? (actions.map((a) => a.result) as unknown as MessageInsert['tool_results']) : null,
    },
  ];
  const { error: insertError } = await supabase.from('ai_messages').insert(rows);
  if (insertError) {
    console.error('[assistant-engine] message persistence failed', insertError);
    return { ok: false, error: describeActionError(insertError, 'I generated a response, but could not save this conversation.') };
  }

  const { data: conv, error: titleReadError } = await supabase.from('ai_conversations').select('title').eq('id', conversationId).maybeSingle();
  if (titleReadError) {
    console.error('[assistant-engine] conversation title read failed', titleReadError);
    return { ok: true };
  }
  const patch: ConversationUpdate = { model };
  if (!conv?.title || conv.title === 'New conversation') patch.title = message.slice(0, 60);
  const { error: updateError } = await supabase.from('ai_conversations').update(patch).eq('id', conversationId);
  if (updateError) console.error('[assistant-engine] conversation metadata update failed', updateError);
  return { ok: true };
}

export type AssistantTurnResult = {
  content: string;
  actions: AssistantActionSummary[];
  persisted: boolean;
  persistenceError?: string;
  model: string;
};

/** Non-streaming transport: run the whole turn and return one JSON-friendly result. */
export async function runAssistantTurn(input: AssistantTurnInput, prepared: PreparedAssistantTurn): Promise<AssistantTurnResult> {
  const { system, messages, tools, provider } = prepared;
  const result = await provider.runTools({ system, messages, tools, maxTokens: ASSISTANT_MAX_TOKENS });
  const actions: ExecutedAssistantAction[] = result.actions.map((a) => ({ name: a.name, args: a.args, result: a.result }));
  const content = finalizeAssistantContent(result.text, actions.length);
  const persisted = await persistAssistantTurn(input.supabase, {
    familyId: input.familyId, conversationId: input.conversationId, message: input.message,
    assistantContent: content, actions, model: provider.model,
  });
  return {
    content,
    actions: actions.map((a) => ({ name: a.name, ...summarizeToolResult(a.result) })),
    persisted: persisted.ok,
    ...(persisted.ok ? {} : { persistenceError: persisted.error }),
    model: provider.model,
  };
}

/**
 * Streaming transport: Server-Sent Events. Emits `action` as tools fire,
 * `delta` text chunks, an `error` if the provider stream breaks, then `done`
 * (after persisting). Falls back to a single non-streaming run when streaming
 * fails before any text was produced (e.g. a proxy buffered the response).
 */
export function createAssistantStream(input: AssistantTurnInput, prepared: PreparedAssistantTurn): ReadableStream<Uint8Array> {
  const { system, messages, tools, provider } = prepared;
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      let content = '';
      const actions: ExecutedAssistantAction[] = [];
      const pushAction = (name: string, args: Record<string, unknown>, result: unknown) => {
        actions.push({ name, args, result });
        send({ type: 'action', name, ...summarizeToolResult(result) });
      };
      try {
        for await (const ev of provider.runToolsStream({ system, messages, tools, maxTokens: ASSISTANT_MAX_TOKENS })) {
          if (ev.type === 'delta') { content += ev.text; send({ type: 'delta', text: ev.text }); }
          else pushAction(ev.name, ev.args, ev.result);
        }
      } catch (streamErr) {
        console.error('[assistant-engine] stream error:', streamErr);
        if (!content) {
          try {
            const result = await provider.runTools({ system, messages, tools, maxTokens: ASSISTANT_MAX_TOKENS });
            for (const a of result.actions) {
              if (!actions.some((x) => x.name === a.name && JSON.stringify(x.args) === JSON.stringify(a.args))) pushAction(a.name, a.args, a.result);
            }
            if (result.text) { content = result.text; send({ type: 'delta', text: result.text }); }
          } catch (fallbackErr) {
            console.error('[assistant-engine] fallback error:', fallbackErr);
            send({ type: 'error', error: describeAIError(fallbackErr).message });
            controller.close();
            return;
          }
        } else {
          send({ type: 'error', error: describeAIError(streamErr).message });
        }
      }

      const assistantContent = finalizeAssistantContent(content, actions.length);
      const persisted = await persistAssistantTurn(input.supabase, {
        familyId: input.familyId, conversationId: input.conversationId, message: input.message,
        assistantContent, actions, model: provider.model,
      });
      if (!persisted.ok) send({ type: 'error', error: persisted.error });
      send({ type: 'done', content: assistantContent, persisted: persisted.ok });
      controller.close();
    },
  });
}
