import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeWeekend, buildWeekendPrompt, parseWeekendResponse } from '@/lib/weekend/weekend-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: events } = await supabase
      .from('weekend_events')
      .select('title, category, venue_name, city, starts_at, is_family_friendly')
      .eq('family_id', familyId)
      .order('starts_at', { ascending: false })
      .limit(200);

    const { count: planCount } = await supabase
      .from('weekend_plans')
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId);

    if (!events || events.length === 0) {
      return NextResponse.json({ error: 'No weekend events to analyze' }, { status: 400 });
    }

    const analysis = analyzeWeekend(events, planCount ?? 0);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildWeekendPrompt(events);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseWeekendResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Weekend AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze weekend events' }, { status: 500 });
  }
}
