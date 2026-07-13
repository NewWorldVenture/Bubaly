import { NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { buildJournalPrompt, parseJournalPrompt, promptOfTheDay } from '@/lib/journal/prompts';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';

// POST /api/ai/journal — returns one personalized reflection prompt for the
// signed-in member, informed by their recent entries. Falls back to the
// evergreen prompt-of-the-day if AI is unavailable, so the UX never dead-ends.
export async function POST() {
  try {
    const ctx = await requireUserContext();
    const memberId = ctx.active.member?.id ?? null;
    const supabase = await createServer();
    const limited = await enforceAIRateLimit(supabase, `ai-journal:${ctx.user.id}`, { limit: 20 });
    if (!limited.ok) return NextResponse.json(
      { error: 'Too many journal requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const { data: recent } = await supabase
      .from('journal_entries')
      .select('mood, body')
      .eq('family_id', ctx.active.familyId)
      .eq('member_id', memberId ?? '')
      .order('entry_date', { ascending: false })
      .limit(5);

    const snippets = (recent ?? []).map((r) => ({ mood: r.mood, snippet: (r.body ?? '').slice(0, 160) }));

    try {
      const { system, user } = buildJournalPrompt(snippets);
      const provider = await resolveProvider();
      const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 60 });
      const prompt = parseJournalPrompt(completion.text || '');
      if (prompt) return NextResponse.json({ prompt, source: 'ai' });
    } catch {
      // fall through to evergreen
    }

    return NextResponse.json({ prompt: promptOfTheDay(), source: 'evergreen' });
  } catch (err) {
    console.error('Journal prompt error:', err);
    return NextResponse.json({ error: 'Failed to generate a prompt' }, { status: 500 });
  }
}
