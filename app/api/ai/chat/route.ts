import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { requireUserContext } from '@/lib/supabase/auth';
import { AiRequestDuplicate, AiRequestNotFiled, withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { resolveProvider, describeAIError, isAIConfigured, type AIMessage } from '@/lib/ai/provider';
import type { TokenUsage } from '@/lib/ai/usage';
import { ASSISTANT_STOPPED, finalizeAssistantContent, stoppedAssistantContent, summarizeToolResult } from '@/lib/ai/assistant-engine';
import { chronologicalMessages } from '@/lib/ai/conversation-session';
import { toStructuredContent } from '@/lib/ai/result-cards';
import { buildAssistantTools } from '@/lib/assistant/tools';
import { wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';
import type { Database } from '@/lib/database.types';
import { rateLimitDb } from '@/lib/server/rate-limit-db';
import { rateLimit } from '@/lib/server/rate-limit';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { AI_ASSISTANT_FEATURE_KEY, accessDeniedResponse, assertAIAccess } from '@/lib/server/ai-access';
import { parseAIChatRequest, parseAssistantTurnKey } from '@/lib/ai/chat-request';
import { assistantTurnRequestKey, findPriorTurn } from '@/lib/ai/assistant-turn-replay';
import { answerPriorTurn } from '@/lib/ai/assistant-turn-answer';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { instantCalendarBounds } from '@/lib/briefing/calendar-window';
import { readCalendarOccurrences, readCountedRows } from '@/lib/calendar/occurrences';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const tz = ctx.active.family.timezone || 'America/New_York';
    const supabase = await createServer();

    // The same assistant as /api/ai, so the same two gates: the feature for the
    // family's plan before the rate limiter, and the plan's monthly allowance
    // (with a closed or trial-ended family refused) after a retried send has
    // been answered from its saved turn (F19), before the model runs.
    // This route asked neither, so it answered every signed-in member of every
    // family, past the Free plan's ten turns and past a closed account.
    const refused = await refuseUnlessEntitled(supabase, familyId, ['/dashboard/assistant']);
    if (refused) return refused;

    // Agentic chat can execute family tools, so bound both request volume and
    // input size before reading family context or invoking the model.
    const key = `ai-chat:${ctx.user.id}`;
    const limited = rateLimit(key, { limit: 20, windowMs: 60_000 });
    const rejected = (retryAfter: number) => NextResponse.json(
      { error: t('chat.tooManyAiChatRequests') },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
    if (!limited.ok) return rejected(limited.retryAfter);

    const durable = await rateLimitDb(supabase, key, { limit: 20, windowMs: 60_000 });
    if (!durable.ok) return rejected(durable.retryAfter);

    const boundedBody = await readBoundedRequestJson(req, MAX_PROVIDER_JSON_BYTES);
    if (!boundedBody.ok) {
      return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    }
    const rawBody = boundedBody.value;
    const parsed = parseAIChatRequest(rawBody);
    if (!parsed.ok) {
      const messageByError = {
        invalid_body: 'Invalid request body',
        conversation_required: 'conversationId is required',
        conversation_invalid: 'conversationId must be a valid UUID',
        message_required: 'Message is required',
        message_too_long: 'Message is too long',
      } as const;
      return NextResponse.json({ error: messageByError[parsed.error] }, { status: 400 });
    }
    const { conversationId, message } = parsed.value;

    // A retried send is the same turn, exactly as on /api/ai (F19; #788
    // review 5393250792): looked up before the family context, the model and
    // the allowance below, none of which run for it.
    const turnKey = parseAssistantTurnKey(rawBody, req.headers.get('idempotency-key'));
    if (!turnKey.ok) return NextResponse.json({ error: t('ai.thisMessageCouldNotBeIdentified'), code: turnKey.error }, { status: 400 });
    if (turnKey.key) {
      const prior = await findPriorTurn(supabase, { familyId, userId: ctx.user.id, conversationId, message }, turnKey.key);
      if (prior.kind !== 'none') return answerPriorTurn(prior, { conversationId, json: false, tr: t });
    }

    // The assistant's tier and switch and the monthly AI allowance the plans
    // sell (F19), checked before the model and before the stream opens: a
    // `return` inside the stream's start() would not reach the caller. A
    // retried send was answered above and is never refused here.
    const access = await assertAIAccess(ctx, { db: supabase, featureKey: AI_ASSISTANT_FEATURE_KEY });
    if (!access.ok) return accessDeniedResponse(access, t);

    if (!(await isAIConfigured())) {
      return NextResponse.json({ error: t('chat.theAiEngineIsnT') }, { status: 503 });
    }

    // Ensure the conversation row exists (the client generates its UUID up front)
    // so the ai_messages FK is satisfied and history accumulates.
    const { error: conversationUpsertError } = await supabase.from('ai_conversations').upsert(
      { id: conversationId, family_id: familyId, user_id: ctx.user.id },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    if (conversationUpsertError) {
      console.error('[ai-chat] conversation initialization failed', conversationUpsertError);
      return NextResponse.json({ error: describeActionError(conversationUpsertError, t('chat.couldNotStartThisConversation')) }, { status: 500 });
    }

    // The client owns the UUID, but never the conversation's authorization
    // boundary. Re-read it through both family and user ownership before
    // exposing history or accepting a new message.
    const { data: conversation, error: conversationReadError } = await supabase.from('ai_conversations')
      .select('id').eq('id', conversationId).eq('family_id', familyId).eq('user_id', ctx.user.id).maybeSingle();
    if (conversationReadError) {
      console.error('[ai-chat] conversation ownership read failed', conversationReadError);
      return NextResponse.json({ error: t('chat.couldNotOpenThisConversation') }, { status: 503 });
    }
    if (!conversation) return NextResponse.json({ error: t('chat.conversationNotFound') }, { status: 404 });

    // Conversation history (text turns), plus a live family snapshot.
    const nowIso = new Date().toISOString();
    const chatTimezone = ctx.active.family.timezone || 'UTC';
    // The legacy toolbox matches names against this exact snapshot. Never
    // hand it a server-capped prefix that can hide the requested exact member.
    const roster = () => supabase.from('family_members')
      .select('id, display_name, role', { count: 'exact' })
      .eq('family_id', familyId).eq('is_active', true).order('id');
    const [
      { data: history, error: historyError },
      { data: members, error: membersError },
      { data: events, error: eventsError },
      { data: chores, error: choresError },
      { data: meals, error: mealsError },
    ] = await settleAll([
      supabase.from('ai_messages').select('role, content, created_at').eq('conversation_id', conversationId)
        .eq('family_id', familyId).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(40),
      readCountedRows<Pick<Database['public']['Tables']['family_members']['Row'], 'id' | 'display_name' | 'role'>>(
        () => roster().limit(1000), (from, to) => roster().range(from, to), 2000, 'active family members',
      ),
      // The next twelve things on the calendar, series included; bounded to a
      // month ahead, which is as far as "what's coming up" reaches
      // (lib/calendar/occurrences.ts).
      readCalendarOccurrences(supabase, familyId, instantCalendarBounds(nowIso, new Date(Date.now() + 30 * 86400000).toISOString(), chatTimezone), chatTimezone, { columns: ['title', 'starts_at', 'category'], limit: 12 }),
      supabase.from('chore_assignments').select('status').eq('family_id', familyId).in('status', ['todo', 'in_progress']),
      supabase.from('meals').select('name, meal_type').eq('family_id', familyId).limit(5),
    ]);
    const contextError = historyError ?? membersError ?? eventsError ?? choresError ?? mealsError;
    if (contextError) {
      console.error('[ai-chat] family context load failed', contextError);
      return NextResponse.json({ error: describeActionError(contextError, t('chat.couldNotLoadTheFamily')) }, { status: 500 });
    }

    const memberRows = (members ?? []).map((m) => ({ id: m.id, display_name: m.display_name }));
    const fmtDate = (iso: string) => {
      try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); }
      catch { return iso.slice(0, 16); }
    };
    const nowLocal = (() => {
      try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date()); }
      catch { return nowIso; }
    })();

    const snapshot = [
      `Family: ${ctx.active.family.name}`,
      `Time zone: ${tz}. Current local date/time: ${nowLocal}.`,
      `Members: ${(members ?? []).map((m) => `${m.display_name} (${m.role})`).join(', ') || 'none'}`,
      `Upcoming events: ${(events ?? []).map((e) => `${e.title} — ${fmtDate(e.starts_at)}`).join('; ') || 'none'}`,
      `Open chores: ${chores?.length ?? 0}`,
      `Saved meals: ${(meals ?? []).map((m) => m.name).join(', ') || 'none'}`,
    ].join('\n');

    const system = [
      "You are Bubaly's family assistant — a warm, sharp, proactive chief of staff for this household.",
      'You can take real actions with the provided tools (calendar, chores, grocery list, to-dos, reminders, notes, goals).',
      'Guidelines:',
      "- When the user asks you to schedule, add, remind, or plan something, USE the tools to actually do it — don't just describe it.",
      '- Resolve relative dates ("tomorrow", "next Friday at 3pm") against the current local date/time and pass ISO 8601 datetimes in the family time zone.',
      '- For calendar.searchEvents specifically, from and to must be full ISO 8601 instants with Z or the correct explicit UTC offset for the household timezone on each requested date, including daylight saving changes. Never use date-only or offsetless search bounds. Keep the inclusive window within 366 days; omitted bounds use the disclosed finite default horizon.',
      '- You may call several tools in one turn (e.g. add multiple grocery items). Prefer one tool call per item.',
      '- After acting, confirm crisply what you did. If you need a critical detail (like a date), ask one short question instead of guessing.',
      '- Be concise, friendly, and genuinely helpful. Never invent data you were not given.',
      '',
      'Current family context:',
      snapshot,
    ].join('\n');

    const messages: AIMessage[] = [
      ...chronologicalMessages(history ?? []).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: message },
    ];

    const provider = await resolveProvider();
    const rawTools = buildAssistantTools(supabase, { familyId, userId: ctx.user.id, memberId: ctx.active.member?.id ?? null, role: ctx.active.role ?? null, members: memberRows, tz });
    const tools = wrapToolsWithTrust(rawTools, supabase, familyId, ctx.active.role, ctx.active.member?.id ?? null);

    // Stream the run as Server-Sent Events: `action` chips as tools fire,
    // `delta` chunks as the reply streams, then a final `done` (after persisting).

    const encoder = new TextEncoder();
    let connected = true;
    // The client's cancellation reaches the provider: `runToolsStream` checks
    // this signal before every model round and every tool, so a person who
    // stopped the turn after its first action does not get its second action
    // written anyway (audit hold on #834, 2026-10-04). What ran before the stop
    // stands and is persisted below, so the conversation records it.
    const stopped = new AbortController();
    // Request cancellation can precede response-reader cancellation, including
    // while the route is preparing its context. Check after subscribing too.
    const stopRequest = () => stopped.abort();
    req.signal.addEventListener('abort', stopRequest, { once: true });
    if (req.signal.aborted) stopRequest();
    const stream = new ReadableStream({
      cancel() { connected = false; stopped.abort(); },
      async start(controller) {
        const send = (e: unknown) => {
          if (!connected) return;
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`)); }
          catch { connected = false; stopped.abort(); }
        };
        // §33: the chat assistant is the other surface the row names by name.
        // It catches its own stream errors and falls back, so nothing ever
        // reached a wrapper's catch — a turn the family watched break recorded
        // nothing at all. `obs.failed` is how a surface that handles its own
        // errors still leaves the evidence.
        try {
        await withAiRequest(
          scopeFromUserContext(ctx, supabase),
          {
            feature: 'chat.assistant', text: 'Assistant chat', kind: 'feature', conversationId,
            clientRequestId: turnKey.key ? assistantTurnRequestKey(turnKey.key) : null,
          },
          async (obs) => {
        let content = '';
        let responseError: string | undefined;
        // What the non-streaming fallback reports it cost: the stream reports
        // no total. A turn the fallback answered is still settled 'failed' with
        // the stream's error, and the Free allowance counts a failed row only
        // for the model work it recorded (lib/server/ai-access.ts), so without
        // this a Free family whose stream always broke chatted without limit.
        let usage: TokenUsage | null | undefined;
        const actions: { name: string; args: Record<string, unknown>; result: unknown }[] = [];
        const pushAction = (name: string, args: Record<string, unknown>, result: unknown) => {
          actions.push({ name, args, result });
          send({ type: 'action', name, ...summarize(result) });
        };
        try {
          for await (const ev of provider.runToolsStream({ system, messages, tools, maxTokens: 1500, signal: stopped.signal })) {
            if (ev.type === 'delta') { content += ev.text; send({ type: 'delta', text: ev.text }); }
            else pushAction(ev.name, ev.args, ev.result);
          }
        } catch (streamErr) {
          console.error('AI stream error:', streamErr);
          // Preserve the first stream error for ordinary failures, but defer
          // observation until a fallback settles: it may commit a tool before
          // cancellation, which must be recorded as a stopped partial turn.
          // Resilience: if streaming failed before producing any text (e.g. a proxy
          // buffered/blocked the SSE response), fall back to a single non-streaming
          // run so the assistant still works. Only surface an error if that fails too.
          // Not when the person stopped the turn: the stream "failed" because they
          // cut it, and a fallback run would do the work they stopped.
          if (!content && actions.length === 0 && !stopped.signal.aborted) {
            try {
              const result = await provider.runTools({ system, messages, tools, maxTokens: 1500, signal: stopped.signal });
              usage = result.usage;
              // No actions existed before this fallback. Each returned entry
              // is one execution, even when two calls had identical arguments.
              for (const a of result.actions) pushAction(a.name, a.args, a.result);
              if (result.text) { content = result.text; send({ type: 'delta', text: result.text }); }
              if (!stopped.signal.aborted) obs.failed(streamErr, { partial: false });
            } catch (fallbackErr) {
              console.error('AI fallback error:', fallbackErr);
              obs.failed(streamErr, { partial: false });
              obs.failed(fallbackErr);
              send({ type: 'error', error: describeAIError(fallbackErr).message });
              if (connected) controller.close();
              return;
            }
          } else if (!stopped.signal.aborted) {
            // We already streamed a partial answer; report the interruption but keep what we have.
            obs.failed(streamErr, { partial: Boolean(content) });
            responseError = describeAIError(streamErr).message;
            send({ type: 'error', error: responseError });
          }
        }

        // The same rule as the live surface, from the same function: a turn
        // whose actions were all refused must not sign off with "Done".
        if (stopped.signal.aborted) {
          responseError = ASSISTANT_STOPPED;
          obs.failed(new Error(ASSISTANT_STOPPED), { partial: actions.length > 0 || Boolean(content) });
        }
        const assistantContent = stopped.signal.aborted ? stoppedAssistantContent(content) : finalizeAssistantContent(content, actions);

        // Persist both turns + the structured actions, then finish the conversation.
        let persistenceError: unknown = null;
        const { error: messageInsertError } = await supabase.from('ai_messages').insert([
            // Bound to this turn's request (0250 `request_id`), so speech and a
            // retried send find this answer exactly, never by time.
            { family_id: familyId, conversation_id: conversationId, role: 'user', content: message, request_id: obs.requestId },
            {
              family_id: familyId, conversation_id: conversationId, role: 'assistant', content: assistantContent,
              request_id: obs.requestId,
              // Saved with the answer, so a retry that finds this exchange
              // before the row settles still knows it was cut off.
              structured_content: toStructuredContent([], [], responseError),
              tool_calls: actions.length ? (actions.map((a) => ({ name: a.name, args: a.args })) as unknown as Database['public']['Tables']['ai_messages']['Insert']['tool_calls']) : null,
              tool_results: actions.length ? (actions.map((a) => ({ name: a.name, ...summarizeToolResult(a.result) })) as unknown as Database['public']['Tables']['ai_messages']['Insert']['tool_results']) : null,
            },
        ]);
        if (messageInsertError) {
          persistenceError = messageInsertError;
          console.error('[ai-chat] message persistence failed', messageInsertError);
          // The answer was streamed and its tools ran, but the exchange was not
          // saved. Partial, not completed: a retry must learn it cannot be
          // replayed, rather than read "answered" and find nothing (as the
          // engine does, #875 review 5970538108).
          obs.failed(new Error(`Turn not persisted: ${messageInsertError.message}`), { partial: true });
        } else {
          const { data: conv, error: titleReadError } = await supabase.from('ai_conversations').select('title').eq('id', conversationId).maybeSingle();
          if (titleReadError) {
            console.error('[ai-chat] conversation title read failed', titleReadError);
          } else {
            const patch: Database['public']['Tables']['ai_conversations']['Update'] = { model: provider.model };
            if (!conv?.title || conv.title === 'New conversation') patch.title = message.slice(0, 60);
            // Ownership was proved above (`.eq('family_id', familyId).eq('user_id',
            // ctx.user.id)` on the read), but the write did not repeat it, and
            // 0255 narrows ai_conversations writes — so a filtered update raised
            // no error and the log below never fired. Scoped and read back: the
            // conversation keeps the title "New conversation" forever otherwise,
            // which is the visible half of a write nothing reported.
            // Confirmed for the LOG: the reply is already streamed and saved, so
            // this never fails the turn. Audit C1-S9-62.
            const { data: titled, error: titleUpdateError } = await supabase
              .from('ai_conversations').update(patch)
              .eq('id', conversationId).eq('family_id', familyId).select('id');
            if (titleUpdateError || wroteNoRows(titled)) {
              console.error('[ai-chat] conversation metadata update failed', titleUpdateError ?? { conversationId, error: 'no rows updated' });
            }
          }
        }
        if (persistenceError) {
          send({ type: 'error', error: describeActionError(persistenceError, t('chat.iGeneratedAResponseBut')) });
        }

        obs.used(provider.model, usage);
        // The turn's request id, so a spoken answer rides on this exchange (F19).
        send({ type: 'done', content: assistantContent, persisted: !persistenceError, requestId: obs.requestId });
        if (connected) controller.close();
          },
        ).finally(() => req.signal.removeEventListener('abort', stopRequest));
        } catch (err) {
          // Another attempt with this send's key filed the turn first; this
          // one ran nothing and counts nothing.
          // Or the turn could not be recorded: keyed, an earlier attempt's
          // outcome is unknown, so nothing ran (fail closed).
          if (!(err instanceof AiRequestDuplicate) && !(err instanceof AiRequestNotFiled)) throw err;
          send({ type: 'error', error: t(err instanceof AiRequestDuplicate ? 'ai.thisMessageIsAlreadyBeingAnswered' : 'ai.accountContextIsTemporarilyUnavailable') });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' },
    });
  } catch (err) {
    console.error('AI chat error:', err);
    return NextResponse.json({ error: describeAIError(err).message }, { status: 500 });
  }
}

// Pull a friendly summary + ok flag out of a tool result for the UI.
function summarize(result: unknown): { ok: boolean; summary: string } {
  if (result && typeof result === 'object') {
    const r = result as { ok?: boolean; summary?: string; error?: string };
    return { ok: r.ok !== false, summary: r.summary ?? r.error ?? 'Done' };
  }
  return { ok: true, summary: 'Done' };
}
