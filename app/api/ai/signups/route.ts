import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeSignups, buildSignupsPrompt, parseSignupsResponse } from '@/lib/opportunities/signups-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: signups } = await supabase
      .from('opportunities')
      .select('title, category, deadline, cost, status')
      .eq('family_id', familyId)
      .order('deadline', { nullsFirst: false })
      .limit(200);

    if (!signups || signups.length === 0) {
      return NextResponse.json({ error: 'No signups to analyze' }, { status: 400 });
    }

    const analysis = analyzeSignups(signups);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildSignupsPrompt(signups);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseSignupsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Signups AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze signups' }, { status: 500 });
  }
}
