import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeTripMemories, buildTripMemoriesPrompt, parseTripMemoriesResponse } from '@/lib/trip-memories/trip-memories-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: memories } = await supabase
      .from('trip_memories')
      .select('title, location, memory_date, note')
      .eq('family_id', familyId)
      .order('memory_date', { ascending: false })
      .limit(200);

    if (!memories || memories.length === 0) {
      return NextResponse.json({ error: 'No trip memories to analyze' }, { status: 400 });
    }

    const analysis = analyzeTripMemories(memories);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildTripMemoriesPrompt(memories);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseTripMemoriesResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Trip memories AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze trip memories' }, { status: 500 });
  }
}
