import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeVolunteer, buildVolunteerPrompt, parseVolunteerResponse } from '@/lib/volunteer/volunteer-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: opportunities } = await supabase
      .from('volunteer_opportunities')
      .select('id, title, organization, category, start_date')
      .eq('family_id', familyId)
      .eq('is_active', true)
      .order('start_date', { ascending: false })
      .limit(200);

    if (!opportunities || opportunities.length === 0) {
      return NextResponse.json({ error: 'No volunteer activities to analyze' }, { status: 400 });
    }

    const { data: hours } = await supabase
      .from('volunteer_hours')
      .select('opportunity_id, hours')
      .eq('family_id', familyId);

    const hoursByOpp = new Map<string, number>();
    for (const h of hours ?? []) {
      if (h.opportunity_id) {
        hoursByOpp.set(h.opportunity_id, (hoursByOpp.get(h.opportunity_id) ?? 0) + h.hours);
      }
    }

    const items = opportunities.map((o) => ({
      title: o.title,
      organization: o.organization,
      category: o.category,
      start_date: o.start_date,
      total_hours: hoursByOpp.get(o.id) ?? 0,
    }));

    const analysis = analyzeVolunteer(items);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildVolunteerPrompt(items);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseVolunteerResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Volunteer AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze volunteer activities' }, { status: 500 });
  }
}
