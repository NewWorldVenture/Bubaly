import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeRewards, buildRewardsPrompt, parseRewardsResponse } from '@/lib/rewards/rewards-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: rewards } = await supabase
      .from('rewards')
      .select('title, cost_points, redeemed_at')
      .eq('family_id', familyId)
      .limit(200);

    if (!rewards || rewards.length === 0) {
      return NextResponse.json({ error: 'No rewards to analyze' }, { status: 400 });
    }

    const analysis = analyzeRewards(rewards);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildRewardsPrompt(rewards);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseRewardsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Rewards AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze rewards' }, { status: 500 });
  }
}
