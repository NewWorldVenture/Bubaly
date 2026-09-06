import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider, describeAIError, isAIConfigured, type AIMessage } from '@/lib/ai/provider';
import { finalizeAssistantContent, summarizeToolResult } from '@/lib/ai/assistant-engine';
import { buildAssistantTools } from '@/lib/assistant/tools';
import { wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';
import type { Database } from '@/lib/database.types';
import { rateLimitDb } from '@/lib/server/rate-limit-db';
import { rateLimit } from '@/lib/server/rate-limit';
import { parseAIChatRequest } from '@/lib/ai/chat-request';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { describeActionError } from '@/lib/supabase/errors';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const tz = ctx.active.family.timezone || 'America/New_York';
    const supabase = await createServer();

    // Agentic chat can execute family tools, so bound both request volume and
    // input size before reading family context or invoking the model.
    const key = `ai-chat:${ctx.user.id}`;
    const limited = rateLimit(key, { limit: 20, windowMs: 60_000 });
    const rejected = (retryAfter: number) => NextResponse.json(
      { error: 'Too many AI chat requests. Please try again shortly.' },
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

    if (!(await isAIConfigured())) {
      return NextResponse.json({ error: 'The AI engine isn’t set up yet. Add an OpenAI API key in Admin → AI Engine.' }, { status: 503 });
    }

    // Ensure the conversation row exists (the client generates its UUID up front)
    // so the ai_messages FK is satisfied and history accumulates.
    const { error: conversationUpsertError } = await supabase.from('ai_conversations').upsert(
      { id: conversationId, family_id: familyId, user_id: ctx.user.id },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    if (conversationUpsertError) {
      console.error('[ai-chat] conversation initialization failed', conversationUpsertError);
      return NextResponse.json({ error: describeActionError(conversationUpsertError, 'Could not start this conversation.') }, { status: 500 });
    }

    // The client owns the UUID, but never the conversation's authorization
    // boundary. Re-read it through both family and user ownership before
    // exposing history or accepting a new message.
    const { data: conversation, error: conversationReadError } = await supabase.from('ai_conversations')
      .select('id').eq('id', conversationId).eq('family_id', familyId).eq('user_id', ctx.user.id).maybeSingle();
    if (conversationReadError) {
      console.error('[ai-chat] conversation ownership read failed', conversationReadError);
      return NextResponse.json({ error: 'Could not open this conversation.' }, { status: 503 });
    }
    if (!conversation) return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });

    // Conversation history (text turns), plus a live family snapshot.
    const nowIso = new Date().toISOString();
    const [
      { data: history, error: historyError },
      { data: members, error: membersError },
      { data: events, error: eventsError },
      { data: chores, error: choresError },
      { data: meals, error: mealsError },
    ] = await Promise.all([
      supabase.from('ai_messages').select('role, content').eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(40),
      supabase.from('family_members').select('id, display_name, role').eq('family_id', familyId).eq('is_active', true),
      supabase.from('calendar_events').select('title, starts_at, category').eq('family_id', familyId).gte('starts_at', nowIso).order('starts_at').limit(12),
      supabase.from('chore_assignments').select('status').eq('family_id', familyId).in('status', ['todo', 'in_progress']),
      supabase.from('meals').select('name, meal_type').eq('family_id', familyId).limit(5),
    ]);
    const contextError = historyError ?? membersError ?? eventsError ?? choresError ?? mealsError;
    if (contextError) {
      console.error('[ai-chat] family context load failed', contextError);
      return NextResponse.json({ error: describeActionError(contextError, 'Could not load the family assistant context.') }, { status: 500 });
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
      '- You may call several tools in one turn (e.g. add multiple grocery items). Prefer one tool call per item.',
      '- After acting, confirm crisply what you did. If you need a critical detail (like a date), ask one short question instead of guessing.',
      '- Be concise, friendly, and genuinely helpful. Never invent data you were not given.',
      '',
      'Current family context:',
      snapshot,
    ].join('\n');

    const messages: AIMessage[] = [
      ...((history ?? []).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))),
      { role: 'user' as const, content: message },
    ];

    const provider = await resolveProvider();
    const rawTools = buildAssistantTools(supabase, { familyId, userId: ctx.user.id, memberId: ctx.active.member?.id ?? null, members: memberRows, tz });
    const tools = wrapToolsWithTrust(rawTools, supabase, familyId, ctx.active.role);

    // Stream the run as Server-Sent Events: `action` chips as tools fire,
    // `delta` chunks as the reply streams, then a final `done` (after persisting).
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (e: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        let content = '';
        const actions: { name: string; args: Record<string, unknown>; result: unknown }[] = [];
        const pushAction = (name: string, args: Record<string, unknown>, result: unknown) => {
          actions.push({ name, args, result });
          send({ type: 'action', name, ...summarize(result) });
        };
        try {
          for await (const ev of provider.runToolsStream({ system, messages, tools, maxTokens: 1500 })) {
            if (ev.type === 'delta') { content += ev.text; send({ type: 'delta', text: ev.text }); }
            else pushAction(ev.name, ev.args, ev.result);
          }
        } catch (streamErr) {
          console.error('AI stream error:', streamErr);
          // Resilience: if streaming failed before producing any text (e.g. a proxy
          // buffered/blocked the SSE response), fall back to a single non-streaming
          // run so the assistant still works. Only surface an error if that fails too.
          if (!content) {
            try {
              const result = await provider.runTools({ system, messages, tools, maxTokens: 1500 });
              for (const a of result.actions) if (!actions.some((x) => x.name === a.name && JSON.stringify(x.args) === JSON.stringify(a.args))) pushAction(a.name, a.args, a.result);
              if (result.text) { content = result.text; send({ type: 'delta', text: result.text }); }
            } catch (fallbackErr) {
              console.error('AI fallback error:', fallbackErr);
              send({ type: 'error', error: describeAIError(fallbackErr).message });
              controller.close();
              return;
            }
          } else {
            // We already streamed a partial answer; report the interruption but keep what we have.
            send({ type: 'error', error: describeAIError(streamErr).message });
          }
        }

        // The same rule as the live surface, from the same function: a turn
        // whose actions were all refused must not sign off with "Done".
        const assistantContent = finalizeAssistantContent(content, actions);

        // Persist both turns + the structured actions, then finish the conversation.
        let persistenceError: unknown = null;
        const { error: messageInsertError } = await supabase.from('ai_messages').insert([
            { family_id: familyId, conversation_id: conversationId, role: 'user', content: message },
            {
              family_id: familyId, conversation_id: conversationId, role: 'assistant', content: assistantContent,
              tool_calls: actions.length ? (actions.map((a) => ({ name: a.name, args: a.args })) as unknown as Database['public']['Tables']['ai_messages']['Insert']['tool_calls']) : null,
              tool_results: actions.length ? (actions.map((a) => ({ name: a.name, ...summarizeToolResult(a.result) })) as unknown as Database['public']['Tables']['ai_messages']['Insert']['tool_results']) : null,
            },
        ]);
        if (messageInsertError) {
          persistenceError = messageInsertError;
          console.error('[ai-chat] message persistence failed', messageInsertError);
        } else {
          const { data: conv, error: titleReadError } = await supabase.from('ai_conversations').select('title').eq('id', conversationId).maybeSingle();
          if (titleReadError) {
            console.error('[ai-chat] conversation title read failed', titleReadError);
          } else {
            const patch: Database['public']['Tables']['ai_conversations']['Update'] = { model: provider.model };
            if (!conv?.title || conv.title === 'New conversation') patch.title = message.slice(0, 60);
            const { error: titleUpdateError } = await supabase.from('ai_conversations').update(patch).eq('id', conversationId);
            if (titleUpdateError) console.error('[ai-chat] conversation metadata update failed', titleUpdateError);
          }
        }
        if (persistenceError) {
          send({ type: 'error', error: describeActionError(persistenceError, 'I generated a response, but could not save this conversation.') });
        }

        send({ type: 'done', content: assistantContent, persisted: !persistenceError });
        controller.close();
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
