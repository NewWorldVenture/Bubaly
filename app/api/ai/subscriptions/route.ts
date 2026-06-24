import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeSubscriptions, buildSubscriptionsPrompt, parseSubscriptionsResponse } from '@/lib/finance/subscriptions-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: subs } = await supabase
      .from('subscriptions_tracked')
      .select('name, cost_cents, cadence, category, status, last_used')
      .eq('family_id', familyId)
      .limit(100);

    if (!subs || subs.length === 0) {
      return NextResponse.json({ error: 'No subscriptions to analyze' }, { status: 400 });
    }

    const analysis = analyzeSubscriptions(subs);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildSubscriptionsPrompt(subs);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseSubscriptionsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Subscriptions AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze subscriptions' }, { status: 500 });
  }
}
