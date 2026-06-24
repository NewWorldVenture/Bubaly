import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeCelebrations, buildCelebrationsPrompt, parseCelebrationsResponse } from '@/lib/celebrations/celebrations-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: dates } = await supabase
      .from('family_dates')
      .select('title, kind, event_date')
      .eq('family_id', familyId)
      .limit(100);

    if (!dates || dates.length === 0) {
      return NextResponse.json({ error: 'No celebrations to analyze' }, { status: 400 });
    }

    const analysis = analyzeCelebrations(dates);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildCelebrationsPrompt(dates);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseCelebrationsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Celebrations AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze celebrations' }, { status: 500 });
  }
}
