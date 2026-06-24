import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeUtilities, buildUtilitiesPrompt, parseUtilitiesResponse } from '@/lib/utilities/utilities-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: bills } = await supabase
      .from('utility_bills')
      .select('kind, provider, amount_cents, period_month')
      .eq('family_id', familyId)
      .order('period_month', { ascending: false })
      .limit(200);

    if (!bills || bills.length === 0) {
      return NextResponse.json({ error: 'No utility bills to analyze' }, { status: 400 });
    }

    const analysis = analyzeUtilities(bills);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildUtilitiesPrompt(bills);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseUtilitiesResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Utilities AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze utility bills' }, { status: 500 });
  }
}
