import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeRenewals, buildRenewalsPrompt, parseRenewalsResponse } from '@/lib/renewals/renewals-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: renewals } = await supabase
      .from('renewals')
      .select('title, category, expires_at, cost, status')
      .eq('family_id', familyId)
      .order('expires_at')
      .limit(200);

    if (!renewals || renewals.length === 0) {
      return NextResponse.json({ error: 'No renewals to analyze' }, { status: 400 });
    }

    const analysis = analyzeRenewals(renewals);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildRenewalsPrompt(renewals);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseRenewalsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Renewals AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze renewals' }, { status: 500 });
  }
}
