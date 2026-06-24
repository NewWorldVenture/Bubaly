import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeGoals, buildGoalsPrompt, parseGoalsResponse } from '@/lib/goals/goals-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: goals } = await supabase
      .from('goals')
      .select('title, description, target_date, progress, is_complete')
      .eq('family_id', familyId)
      .limit(100);

    if (!goals || goals.length === 0) {
      return NextResponse.json({ error: 'No goals to analyze' }, { status: 400 });
    }

    const analysis = analyzeGoals(goals);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildGoalsPrompt(goals);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseGoalsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Goals AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze goals' }, { status: 500 });
  }
}
