import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeTrips, buildTripsPrompt, parseTripsResponse } from '@/lib/trips/trips-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: trips } = await supabase
      .from('trips')
      .select('id, name, destination, status, start_date, end_date')
      .eq('family_id', familyId)
      .limit(100);

    if (!trips || trips.length === 0) {
      return NextResponse.json({ error: 'No trips to analyze' }, { status: 400 });
    }

    const tripEntries = [];
    for (const t of trips) {
      const { count: total } = await supabase
        .from('trip_items')
        .select('id', { count: 'exact', head: true })
        .eq('trip_id', t.id);
      const { count: done } = await supabase
        .from('trip_items')
        .select('id', { count: 'exact', head: true })
        .eq('trip_id', t.id)
        .eq('is_done', true);
      tripEntries.push({
        destination: t.destination ?? t.name,
        status: t.status,
        start_date: t.start_date,
        end_date: t.end_date,
        checklist_total: total ?? 0,
        checklist_done: done ?? 0,
      });
    }

    const analysis = analyzeTrips(tripEntries);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildTripsPrompt(tripEntries);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseTripsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Trips AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze trips' }, { status: 500 });
  }
}
