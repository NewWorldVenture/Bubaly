import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeRides, buildRidesPrompt, parseRidesResponse } from '@/lib/rides/rides-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: rides } = await supabase
      .from('rides')
      .select('title, ride_date, pickup_time, dropoff_time, pickup_location, dropoff_location, driver_id, status')
      .eq('family_id', familyId)
      .order('ride_date', { ascending: false })
      .limit(200);

    if (!rides || rides.length === 0) {
      return NextResponse.json({ error: 'No rides to analyze' }, { status: 400 });
    }

    const analysis = analyzeRides(rides);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildRidesPrompt(rides);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseRidesResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Rides AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze rides' }, { status: 500 });
  }
}
