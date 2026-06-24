import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeBehavior, buildBehaviorPrompt, parseBehaviorResponse } from '@/lib/behavior/behavior-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: entries } = await supabase
      .from('behavior_logs')
      .select('kind, category, points, occurred_at')
      .eq('family_id', familyId)
      .order('occurred_at', { ascending: false })
      .limit(200);

    if (!entries || entries.length === 0) {
      return NextResponse.json({ error: 'No behavior entries to analyze' }, { status: 400 });
    }

    const analysis = analyzeBehavior(entries);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildBehaviorPrompt(entries);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseBehaviorResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Behavior AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze behavior' }, { status: 500 });
  }
}
