import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeSports, buildSportsPrompt, parseSportsResponse } from '@/lib/sports/sports-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: events } = await supabase
      .from('sports_events')
      .select('sport, title, event_type, starts_at')
      .eq('family_id', familyId)
      .order('starts_at', { ascending: false })
      .limit(200);

    if (!events || events.length === 0) {
      return NextResponse.json({ error: 'No sports events to analyze' }, { status: 400 });
    }

    const analysis = analyzeSports(events);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildSportsPrompt(events);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseSportsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Sports AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze sports events' }, { status: 500 });
  }
}
