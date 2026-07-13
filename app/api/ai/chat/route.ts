import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider, describeAIError, isAIConfigured, type AIMessage } from '@/lib/ai/provider';
import { buildAssistantTools } from '@/lib/assistant/tools';
import { wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';
import type { Database } from '@/lib/database.types';
import { rateLimitDb } from '@/lib/server/rate-limit-db';
import { rateLimit } from '@/lib/server/rate-limit';
import { parseAIChatRequest } from '@/lib/ai/chat-request';

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

    let rawBody: unknown;
    try { rawBody = await req.json(); }
    catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
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
    await supabase.from('ai_conversations').upsert(
      { id: conversationId, family_id: familyId, user_id: ctx.user.id },
      { onConflict: 'id', ignoreDuplicates: true },
    );

    // Conversation history (text turns), plus a live family snapshot.
    const nowIso = new Date().toISOString();
    const [{ data: history }, { data: members }, { data: events }, { data: chores }, { data: meals }] = await Promise.all([
      supabase.from('ai_messages').select('role, content').eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(40),
      supabase.from('family_members').select('id, display_name, role').eq('family_id', familyId).eq('is_active', true),
      supabase.from('calendar_events').select('title, starts_at, category').eq('family_id', familyId).gte('starts_at', nowIso).order('starts_at').limit(12),
      supabase.from('chore_assignments').select('status').eq('family_id', familyId).in('status', ['todo', 'in_progress']),
      supabase.from('meals').select('name, meal_type').eq('family_id', familyId).limit(5),
    ]);

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
    const rawTools = buildAssistantTools(supabase, { familyId, userId: ctx.user.id, members: memberRows, tz });
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
              const { message, detail } = describeAIError(fallbackErr);
              send({ type: 'error', error: message, detail });
              controller.close();
              return;
            }
          } else {
            // We already streamed a partial answer; report the interruption but keep what we have.
            send({ type: 'error', error: describeAIError(streamErr).message });
          }
        }

        const assistantContent = content.trim() || (actions.length ? 'Done — I’ve updated that for you.' : 'I’m not sure how to help with that yet.');

        // Persist both turns + the structured actions, then finish the conversation.
        try {
          await supabase.from('ai_messages').insert([
            { family_id: familyId, conversation_id: conversationId, role: 'user', content: message },
            {
              family_id: familyId, conversation_id: conversationId, role: 'assistant', content: assistantContent,
              tool_calls: actions.length ? (actions.map((a) => ({ name: a.name, args: a.args })) as unknown as Database['public']['Tables']['ai_messages']['Insert']['tool_calls']) : null,
              tool_results: actions.length ? (actions.map((a) => a.result) as unknown as Database['public']['Tables']['ai_messages']['Insert']['tool_results']) : null,
            },
          ]);
          const { data: conv } = await supabase.from('ai_conversations').select('title').eq('id', conversationId).maybeSingle();
          const patch: Database['public']['Tables']['ai_conversations']['Update'] = { model: provider.model };
          if (!conv?.title || conv.title === 'New conversation') patch.title = message.slice(0, 60);
          await supabase.from('ai_conversations').update(patch).eq('id', conversationId);
        } catch (err) {
          console.error('AI persist error:', err);
        }

        send({ type: 'done', content: assistantContent });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' },
    });
  } catch (err) {
    console.error('AI chat error:', err);
    const { message, detail } = describeAIError(err);
    return NextResponse.json({ error: message, detail }, { status: 500 });
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
