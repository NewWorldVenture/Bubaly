import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { resolveProvider, describeAIError, isAIConfigured, type AIMessage } from '@/lib/ai/provider';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
export const maxDuration = 60;

// A general-purpose, non-streaming AI completion used by features that need a
// simple "send messages → get one reply" contract (AI Concierge chat, the AI
// Message Agent draft-reply, Front Desk reply drafting). Distinct from
// /api/ai/chat, which is the agentic, tool-using, SSE assistant.
type Body = {
  systemPrompt?: string;
  messages?: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
};

const MAX_MESSAGES = 30;
const MAX_CHARS = 8000;

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const userId = ctx.user.id;
    const supabase = await createServer();
    const limited = await enforceAIRateLimit(supabase, `ai-assist:${userId}`, { limit: 30 });
    if (!limited.ok) return NextResponse.json(
      { error: 'Too many AI requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    if (!(await isAIConfigured())) {
      return NextResponse.json(
        { error: 'The AI engine isn’t set up yet. Add an OpenAI API key in Admin → AI Engine.' },
        { status: 503 },
      );
    }

    const boundedBody = await readBoundedRequestJson(req, MAX_PROVIDER_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    const body = (boundedBody.value ?? {}) as Body;
    const incoming = Array.isArray(body.messages) ? body.messages : [];
    if (incoming.length === 0) return NextResponse.json({ error: 'No messages provided.' }, { status: 400 });

    // Sanitize: clamp count + length, keep only valid roles/content.
    const messages: AIMessage[] = incoming
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-MAX_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));

    if (messages.length === 0) return NextResponse.json({ error: 'No valid messages provided.' }, { status: 400 });
    if (messages[messages.length - 1].role !== 'user') {
      return NextResponse.json({ error: 'The last message must be from the user.' }, { status: 400 });
    }

    const system = (body.systemPrompt && body.systemPrompt.trim())
      ? body.systemPrompt.slice(0, 4000)
      : 'You are a warm, concise, genuinely helpful family assistant. Keep replies short and actionable.';

    const maxTokens = Math.min(Math.max(body.maxTokens ?? 700, 100), 1500);

    const text = (await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'assist', text: 'Assist' },
      async (obs) => {
        const provider = await resolveProvider();
        const completion = await provider.complete({ system, messages, tools: [], maxTokens });
        obs.used(completion.model ?? 'unknown', completion.usage);
        return completion.text || '';
      },
    )).trim();
    if (!text) return NextResponse.json({ error: 'Could not generate a response. Please try again.' }, { status: 502 });

    return NextResponse.json({ message: text });
  } catch (err) {
    const { message, detail } = describeAIError(err);
    console.error('AI assist error:', err, detail);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
