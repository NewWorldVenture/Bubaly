import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeHealthVisits, buildHealthVisitsPrompt, parseHealthVisitsResponse } from '@/lib/health/health-visits-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: visits } = await supabase
      .from('health_visits')
      .select('title, kind, visit_date, provider_name, follow_up_date, cost_cents')
      .eq('family_id', familyId)
      .order('visit_date', { ascending: false })
      .limit(200);

    if (!visits || visits.length === 0) {
      return NextResponse.json({ error: 'No health visits to analyze' }, { status: 400 });
    }

    const analysis = analyzeHealthVisits(visits);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildHealthVisitsPrompt(visits);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseHealthVisitsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Health visits AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze health visits' }, { status: 500 });
  }
}
