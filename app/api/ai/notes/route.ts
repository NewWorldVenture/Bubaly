import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { buildNotesPrompt, parseNotesResponse } from '@/lib/notes/ai';

// AI Assist for the Notes module: turns a free-form family note into a short
// summary, concrete action items, and topic tags. Auth-gated to the active
// family member; the actual write-back happens client-side via the existing
// Supabase notes update path so RLS stays the source of truth.
export async function POST(req: NextRequest) {
  try {
    await requireUserContext();

    const { content } = (await req.json()) as { content?: string };
    const text = (content ?? '').trim();
    if (!text) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 });
    }

    const { system, user } = buildNotesPrompt(text);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 700,
    });

    const insights = parseNotesResponse(completion.text || '');
    if (!insights.summary && insights.actionItems.length === 0 && insights.tags.length === 0) {
      return NextResponse.json({ error: 'Could not analyze this note. Please try again.' }, { status: 502 });
    }

    return NextResponse.json({ insights });
  } catch (err) {
    console.error('Notes AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze note' }, { status: 500 });
  }
}
