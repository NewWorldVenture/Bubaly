import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeReunions, buildReunionPrompt, parseReunionResponse } from '@/lib/reunion/reunion-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: reunions } = await supabase
      .from('family_reunions')
      .select('id, title, start_date, end_date, location')
      .eq('family_id', familyId)
      .eq('is_active', true)
      .order('start_date')
      .limit(50);

    if (!reunions || reunions.length === 0) {
      return NextResponse.json({ error: 'No reunions to analyze' }, { status: 400 });
    }

    const reunionIds = reunions.map((r) => r.id);
    const { data: rsvps } = await supabase
      .from('reunion_rsvps')
      .select('reunion_id')
      .in('reunion_id', reunionIds);

    const guestCounts = new Map<string, number>();
    for (const rsvp of rsvps ?? []) {
      guestCounts.set(rsvp.reunion_id, (guestCounts.get(rsvp.reunion_id) ?? 0) + 1);
    }

    const items = reunions.map((r) => ({
      title: r.title,
      start_date: r.start_date,
      end_date: r.end_date,
      location: r.location,
      guest_count: guestCounts.get(r.id) ?? 0,
    }));

    const analysis = analyzeReunions(items);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildReunionPrompt(items);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseReunionResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Reunion AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze reunions' }, { status: 500 });
  }
}
