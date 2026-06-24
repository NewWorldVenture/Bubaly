import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeCalendarEvents, buildCalendarPrompt, parseCalendarResponse } from '@/lib/calendar/calendar-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: events } = await supabase
      .from('calendar_events')
      .select('title, category, starts_at, all_day')
      .eq('family_id', familyId)
      .order('starts_at', { ascending: false })
      .limit(100);

    if (!events || events.length === 0) {
      return NextResponse.json({ error: 'No calendar events to analyze' }, { status: 400 });
    }

    const analysis = analyzeCalendarEvents(events);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildCalendarPrompt(events);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseCalendarResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Calendar AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze calendar' }, { status: 500 });
  }
}
