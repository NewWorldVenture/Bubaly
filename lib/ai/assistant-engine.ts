// lib/ai/assistant-engine.ts — the agentic family assistant, as a reusable
// engine behind the canonical /api/ai route.
//
// One turn = classify the message, build the household context the intent
// needs (`lib/ai/context/builder.ts` — §27 slices, §4 policy, §44 fencing) +
// conversation history, build the tool set (the assistant toolbox, the
// lib/ai/actions.ts bridge, and the rest of the `lib/ai/tools` registry —
// trust-wrapped for the caller's role), run the provider's tool loop, then
// persist both turns. Two transports share the exact same preparation and
// persistence:
//   - SSE stream (web): `action` lines as tools fire, `card` / `run` events for
//     the outcomes worth more than a line (§53), `delta` text chunks, `done`.
//   - JSON (mobile, scripts): one response with the final text, the action
//     summaries and the same cards.
// The wire contract for both is `lib/ai/result-cards.ts`.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { resolveProvider, describeAIError, type AIMessage, type AIProvider, type ToolSpec } from '@/lib/ai/provider';
import { buildAssistantTools } from '@/lib/assistant/tools';
import { wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';
import { buildActionTools, mergeToolSets } from '@/lib/ai/action-tools';
import { buildContext, type ContextBundle } from '@/lib/ai/context/builder';
import { classifyIntent, type IntentClassification, type IntentKey } from '@/lib/ai/context/intents';
import { ASSISTANT_RULES } from '@/lib/ai/prompts/assistant';
import {
  approvalIdFromToolResult, cardFromToolResult, runHref, runIdFromToolResult, toStructuredContent, toolResultData,
  type CardContext, type ResultCard, type StructuredContent,
} from '@/lib/ai/result-cards';
import { toToolSpecs } from '@/lib/ai/tools/legacy-adapter';
import { getTool, toolNames } from '@/lib/ai/tools/registry';
import { toApprovalCardData, type TrustApproval } from '@/lib/approvals/card-data';
import { isManager, type MemberRole } from '@/lib/constants/roles';
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
  /** Skip classification when the caller already knows what this is (a routine, a card action). */
  intent?: IntentKey;
  /** Where the person is in the app — narrows classification and lets slices focus. */
  pageContext?: { module?: string; entityIds?: string[] } | null;
};

export type ExecutedAssistantAction = { name: string; args: Record<string, unknown>; result: unknown };
export type AssistantActionSummary = { name: string; ok: boolean; summary: string };

export type PreparedAssistantTurn = {
  system: string;
  messages: AIMessage[];
  tools: ToolSpec[];
  provider: AIProvider;
  /** How the message was read, so the route can report it and evals can assert it. */
  intent: IntentClassification;
  /** The household context the prompt was built from; `stats` say what was loaded. */
  context: ContextBundle;
  /** Member names and currency, so a card says "Dan" and "$40", never an id or a bare number. */
  cardContext: CardContext;
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

/** What one executed action actually did, for the fallback sentence below. */
type ActionState = 'done' | 'pending' | 'failed';

function actionState(result: unknown): ActionState {
  const r = result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
  if (r && (r.pending_approval === true || r.pendingApproval === true)) return 'pending';
  return summarizeToolResult(result).ok ? 'done' : 'failed';
}

/**
 * The assistant's final text, with a fallback when the model only acted.
 *
 * The fallback used to be chosen from the action COUNT alone, so a turn whose
 * every action was refused by the household's own policy — the exact case the
 * trust gate exists to produce — signed off with "Done — I’ve updated that
 * for you." A refusal that reads as a success is worse than no gate at all: the
 * family believes the thing happened, and finds out when it does not.
 *
 * A queued approval is not "done" either. Nothing has been written yet, and the
 * card beneath the message is asking a parent to decide.
 */
export function finalizeAssistantContent(text: string, actions: readonly { result: unknown }[]): string {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  if (!actions.length) return 'I’m not sure how to help with that yet.';

  const states = actions.map((a) => actionState(a.result));
  const count = (s: ActionState) => states.filter((x) => x === s).length;
  const firstFailure = actions.find((a) => actionState(a.result) === 'failed');
  const failureLine = firstFailure ? summarizeToolResult(firstFailure.result).summary : 'That didn’t work.';

  if (!count('failed') && !count('pending')) return 'Done — I’ve updated that for you.';
  if (!count('done') && !count('failed')) {
    return count('pending') === 1
      ? 'That needs a parent’s OK, so I’ve sent it for approval.'
      : 'Those need a parent’s OK, so I’ve sent them for approval.';
  }
  if (!count('done') && !count('pending')) return failureLine;

  // Mixed. Naming each part beats letting the happiest one speak for the turn.
  return [
    count('done') ? 'I’ve done part of that.' : null,
    count('pending') ? `${count('pending')} of them ${count('pending') === 1 ? 'needs' : 'need'} a parent’s OK.` : null,
    count('failed') ? failureLine : null,
  ].filter(Boolean).join(' ');
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

// The assistant's standing rules live in lib/ai/prompts/assistant.ts (§66,
// version-controlled, shared with the planner) so the two prompt builders
// below cannot drift from each other or from the plan prompt.

/**
 * The legacy prompt over a hand-assembled snapshot. Kept for callers that
 * build their own five-field picture (tests, scripts); the assistant itself
 * now prompts from a context bundle via `buildAssistantSystemPromptFromContext`.
 */
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

  return [...ASSISTANT_RULES, '', 'Current family context:', context].join('\n');
}

/**
 * The prompt the assistant actually runs with: the standing rules plus the
 * context bundle's rendering — header, the slices the intent asked for, every
 * row-derived string fenced, already trimmed to budget.
 */
export function buildAssistantSystemPromptFromContext(context: Pick<ContextBundle, 'text'>): string {
  return [...ASSISTANT_RULES, '', 'Current family context:', context.text].join('\n');
}

/**
 * Load everything a turn needs. Returns a tagged failure (never throws for
 * data errors) so routes can answer with a precise status.
 */
export async function prepareAssistantTurn(input: AssistantTurnInput): Promise<
  { ok: true; turn: PreparedAssistantTurn } | { ok: false; error: string }
> {
  const { supabase, familyId, userId, conversationId, message } = input;
  const [
    { data: history, error: historyError },
    { data: members, error: membersError },
  ] = await Promise.all([
    supabase.from('ai_messages').select('role, content').eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(40),
    // `user_id` is selected so the acting member can be picked out of the roster
    // — the tool registry scopes writes by `family_members.id`, not by the auth
    // user id. The context builder loads the roster again through the family
    // service; that read is what gives it ages and manager flags.
    supabase.from('family_members').select('id, user_id, display_name, role').eq('family_id', familyId).eq('is_active', true),
  ]);
  const contextError = historyError ?? membersError;
  if (contextError) {
    console.error('[assistant-engine] conversation context load failed', contextError);
    return { ok: false, error: describeActionError(contextError, 'Could not load the family assistant context.') };
  }

  const memberRows = (members ?? []).map((m) => ({ id: m.id, display_name: m.display_name }));
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

  // What is being asked decides which parts of the household the prompt
  // carries (§27). Fast paths are free; the model is consulted only for text
  // none of them recognises, and a classifier outage degrades to "other".
  const intent: IntentClassification = input.intent
    ? { intent: input.intent, confidence: 1, entities: {}, source: 'fast_path' }
    : await classifyIntent(scope, message, { pageContext: input.pageContext ?? null });

  const context = await buildContext(scope, { intent: intent.intent, pageContext: input.pageContext ?? null });
  if (!context.ok) {
    console.error('[assistant-engine] household context build failed', { intent: intent.intent, error: context.error });
    return { ok: false, error: context.error };
  }
  const system = buildAssistantSystemPromptFromContext(context.data);

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
  const assistantTools = buildAssistantTools(supabase, { familyId, userId, memberId: acting?.id ?? null, members: memberRows, tz: input.tz });
  const actionTools = buildActionTools({ supabase, familyId, userId });
  const covered = new Set(
    [...assistantTools, ...actionTools]
      .map((tool) => getTool(tool.name)?.name)
      .filter((name): name is string => Boolean(name)),
  );
  const registryTools = toToolSpecs(scope, { names: toolNames().filter((name) => !covered.has(name)) });
  const tools = wrapToolsWithTrust(
    mergeToolSets(assistantTools, actionTools, registryTools),
    supabase, familyId, input.role, acting?.id ?? null,
  );

  const provider = await resolveProvider();
  const cardContext: CardContext = {
    members: Object.fromEntries(memberRows.map((m) => [m.id, m.display_name])),
    currency: context.data.header.currency,
  };
  return { ok: true, turn: { system, messages, tools, provider, intent, context: context.data, cardContext } };
}

// ─── Outcomes: cards, runs, approvals ───────────────────────────────────────

/** What one executed tool contributes beyond its summary line. */
export type ToolOutcomeView = { card: ResultCard | null; runId: string | null; runStatus: string | null };

/**
 * The card and run for a tool result. Synchronous and pure apart from the
 * registry lookup, which turns whatever spelling the model used into the
 * canonical name the card builder keys on.
 */
export function outcomeOfAction(name: string, args: Record<string, unknown>, result: unknown, cardContext: CardContext): ToolOutcomeView {
  const canonical = getTool(name)?.name ?? name;
  const card = cardFromToolResult(canonical, args, result, cardContext);
  const runId = runIdFromToolResult(result);
  const data = toolResultData(result);
  const runStatus = data && typeof data.state === 'string' ? data.state : data && typeof data.status === 'string' ? data.status : null;
  return { card, runId, runStatus };
}

/**
 * The approval card for a gated tool result. A pending approval is a real
 * outcome (§31): the family sees the decision, not a "waiting" line, so the
 * row is read back (family-scoped, under the caller's RLS) and rendered with
 * the same data the inbox uses. A failed read degrades to no card — the
 * `action` line already said the request is waiting on a parent.
 */
export async function approvalCardFor(
  supabase: DB,
  args: { familyId: string; role: string | null | undefined; approvalId: string },
): Promise<ResultCard | null> {
  const { data, error } = await supabase
    .from('approval_requests')
    .select('*')
    .eq('id', args.approvalId)
    .eq('family_id', args.familyId)
    .maybeSingle();
  if (error) {
    console.error('[assistant-engine] approval card read failed', error);
    return null;
  }
  if (!data) return null;
  const approval = toApprovalCardData(data as unknown as TrustApproval, { requestedBy: null, canEdit: isManager(args.role) });
  return { kind: 'approval', title: approval.title, approval };
}

/** Persist both turns + structured actions and refresh the conversation metadata. */
export async function persistAssistantTurn(
  supabase: DB,
  args: {
    familyId: string; conversationId: string; message: string; assistantContent: string; actions: ExecutedAssistantAction[]; model: string;
    /** The turn's cards and runs (0250 `structured_content`), so the conversation re-opens with its outcomes. */
    structured?: StructuredContent | null;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { familyId, conversationId, message, assistantContent, actions, model } = args;
  const rows: MessageInsert[] = [
    { family_id: familyId, conversation_id: conversationId, role: 'user', content: message },
    {
      family_id: familyId, conversation_id: conversationId, role: 'assistant', content: assistantContent, model,
      tool_calls: actions.length ? (actions.map((a) => ({ name: a.name, args: a.args })) as unknown as MessageInsert['tool_calls']) : null,
      // Summaries only: raw results can carry transaction rows or a signed
      // document URL, and a conversation row outlives the moment it was shown.
      tool_results: actions.length ? (actions.map((a) => ({ name: a.name, ...summarizeToolResult(a.result) })) as unknown as MessageInsert['tool_results']) : null,
      structured_content: args.structured ? (args.structured as unknown as MessageInsert['structured_content']) : null,
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
  /** The turn's outcomes as cards, in the order the tools produced them. */
  cards: ResultCard[];
  /** Runs the turn started or attached; the client links each to its run page. */
  runIds: string[];
  persisted: boolean;
  persistenceError?: string;
  model: string;
};

/**
 * Every card and run for a finished turn's actions, in order. The approval
 * reads are the only async part; they run one at a time so a turn that queued
 * several approvals renders them in the order the family expects.
 */
async function collectOutcomes(input: AssistantTurnInput, prepared: PreparedAssistantTurn, actions: ExecutedAssistantAction[]): Promise<{ cards: ResultCard[]; runIds: string[] }> {
  const cards: ResultCard[] = [];
  const runIds: string[] = [];
  for (const a of actions) {
    const outcome = outcomeOfAction(a.name, a.args, a.result, prepared.cardContext);
    if (outcome.card) cards.push(outcome.card);
    if (outcome.runId) runIds.push(outcome.runId);
    const approvalId = approvalIdFromToolResult(a.result);
    if (approvalId) {
      const card = await approvalCardFor(input.supabase, { familyId: input.familyId, role: input.role, approvalId });
      if (card) cards.push(card);
    }
  }
  return { cards, runIds: [...new Set(runIds)] };
}

/** Non-streaming transport: run the whole turn and return one JSON-friendly result. */
export async function runAssistantTurn(input: AssistantTurnInput, prepared: PreparedAssistantTurn): Promise<AssistantTurnResult> {
  const { system, messages, tools, provider } = prepared;
  const result = await provider.runTools({ system, messages, tools, maxTokens: ASSISTANT_MAX_TOKENS });
  const actions: ExecutedAssistantAction[] = result.actions.map((a) => ({ name: a.name, args: a.args, result: a.result }));
  const content = finalizeAssistantContent(result.text, actions);
  const { cards, runIds } = await collectOutcomes(input, prepared, actions);
  const persisted = await persistAssistantTurn(input.supabase, {
    familyId: input.familyId, conversationId: input.conversationId, message: input.message,
    assistantContent: content, actions, model: provider.model, structured: toStructuredContent(cards, runIds),
  });
  return {
    content,
    actions: actions.map((a) => ({ name: a.name, ...summarizeToolResult(a.result) })),
    cards,
    runIds,
    persisted: persisted.ok,
    ...(persisted.ok ? {} : { persistenceError: persisted.error }),
    model: provider.model,
  };
}

/**
 * Streaming transport: Server-Sent Events. Emits `action` as tools fire, a
 * `card` right after any action whose result deserves one and a `run` for any
 * that started a run, `delta` text chunks, an `error` if the provider stream
 * breaks, then `done` (after persisting). Falls back to a single non-streaming
 * run when streaming fails before any text was produced (e.g. a proxy
 * buffered the response). Event shapes: `AssistantStreamEvent` in
 * `lib/ai/result-cards.ts`.
 */
export function createAssistantStream(input: AssistantTurnInput, prepared: PreparedAssistantTurn): ReadableStream<Uint8Array> {
  const { system, messages, tools, provider } = prepared;
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      let content = '';
      const actions: ExecutedAssistantAction[] = [];
      const cards: ResultCard[] = [];
      const runIds: string[] = [];
      // The card follows its action on the wire, so a client that renders as
      // it reads shows the line first and the card the moment it exists. The
      // approval read is the only await; the provider generator waits for it.
      const pushAction = async (name: string, args: Record<string, unknown>, result: unknown) => {
        actions.push({ name, args, result });
        send({ type: 'action', name, ...summarizeToolResult(result) });
        const outcome = outcomeOfAction(name, args, result, prepared.cardContext);
        if (outcome.card) { cards.push(outcome.card); send({ type: 'card', card: outcome.card }); }
        if (outcome.runId) {
          if (!runIds.includes(outcome.runId)) runIds.push(outcome.runId);
          send({ type: 'run', runId: outcome.runId, href: runHref(outcome.runId), status: outcome.runStatus ?? 'queued', summary: summarizeToolResult(result).summary });
        }
        const approvalId = approvalIdFromToolResult(result);
        if (approvalId) {
          const card = await approvalCardFor(input.supabase, { familyId: input.familyId, role: input.role, approvalId });
          if (card) { cards.push(card); send({ type: 'card', card }); }
        }
      };
      try {
        for await (const ev of provider.runToolsStream({ system, messages, tools, maxTokens: ASSISTANT_MAX_TOKENS })) {
          if (ev.type === 'delta') { content += ev.text; send({ type: 'delta', text: ev.text }); }
          else await pushAction(ev.name, ev.args, ev.result);
        }
      } catch (streamErr) {
        console.error('[assistant-engine] stream error:', streamErr);
        if (!content) {
          try {
            const result = await provider.runTools({ system, messages, tools, maxTokens: ASSISTANT_MAX_TOKENS });
            for (const a of result.actions) {
              if (!actions.some((x) => x.name === a.name && JSON.stringify(x.args) === JSON.stringify(a.args))) await pushAction(a.name, a.args, a.result);
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

      const assistantContent = finalizeAssistantContent(content, actions);
      const persisted = await persistAssistantTurn(input.supabase, {
        familyId: input.familyId, conversationId: input.conversationId, message: input.message,
        assistantContent, actions, model: provider.model, structured: toStructuredContent(cards, runIds),
      });
      if (!persisted.ok) send({ type: 'error', error: persisted.error });
      send({ type: 'done', content: assistantContent, persisted: persisted.ok });
      controller.close();
    },
  });
}
