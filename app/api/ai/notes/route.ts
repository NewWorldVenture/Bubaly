import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { buildNotesPrompt, parseNotesResponse } from '@/lib/notes/ai';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';

// AI Assist for the Notes module: turns a free-form family note into a short
// summary, concrete action items, and topic tags. Auth-gated to the active
// family member; the actual write-back happens client-side via the existing
// Supabase notes update path so RLS stays the source of truth.
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const supabase = await createServer();
    const limited = await enforceAIRateLimit(supabase, `ai-notes:${ctx.user.id}`, { limit: 20 });
    if (!limited.ok) return NextResponse.json(
      { error: t('notes.tooManyNoteAnalysisRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    const { content } = (boundedBody.value ?? {}) as { content?: string };
    const text = (content ?? '').trim();
    if (!text) {
      return NextResponse.json({ error: t('notes.noteContentIsRequired') }, { status: 400 });
    }

    const { system, user } = buildNotesPrompt(text);
    // The note itself is not stored on the row — a family note is exactly the
    // kind of thing `text` must not carry verbatim.
    const insights = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'notes.assist', text: 'Analyse a note' },
      async (obs) => {
        const provider = await resolveProvider();
        const completion = await provider.complete({
          system,
          messages: [{ role: 'user', content: user }],
          tools: [],
          maxTokens: 700,
        });
        obs.used(completion.model ?? 'unknown', completion.usage);
        const parsed = parseNotesResponse(completion.text || '');
        // The model answered and the tokens are spent; the answer was just
        // unusable. Recorded as a failure, because `completed` here would
        // describe the one turn the family actually complained about.
        if (!parsed.summary && parsed.actionItems.length === 0 && parsed.tags.length === 0) {
          obs.failed(new Error('The model returned no usable summary, actions or tags.'));
          return null;
        }
        return parsed;
      },
    );
    if (!insights) {
      return NextResponse.json({ error: t('notes.couldNotAnalyzeThisNote') }, { status: 502 });
    }

    return NextResponse.json({ insights });
  } catch (err) {
    console.error('Notes AI error:', err);
    return NextResponse.json({ error: t('notes.failedToAnalyzeNote') }, { status: 500 });
  }
}
